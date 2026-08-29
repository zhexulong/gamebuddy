import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createPublishedWindowsStardewFolderPicker, selectStardewFolder } from "./index.js";
import { createTestWindowsStardewFolderPicker } from "./index.test-support.js";

function child(outcome: "selected" | "cancelled" | "malformed" | "overflow" | "stderr" | "nonzero" | "timeout" | "extra-key" | "extra-line" | "bom" | "unc" | "relative"): ChildProcess {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { queueMicrotask(() => process.emit("close", null, "SIGTERM")); return true; },
  });
  queueMicrotask(() => {
    if (outcome === "timeout") return;
    if (outcome === "selected") process.stdout.end('{"schemaVersion":1,"status":"selected","path":"C:\\\\Games\\\\Stardew Valley"}\n');
    else if (outcome === "cancelled") process.stdout.end('{"schemaVersion":1,"status":"cancelled"}\n');
    else if (outcome === "overflow") process.stdout.end(Buffer.alloc(16 * 1024 + 1));
    else if (outcome === "extra-key") process.stdout.end('{"schemaVersion":1,"status":"cancelled","path":"C:\\\\secret"}\n');
    else if (outcome === "extra-line") process.stdout.end('{"schemaVersion":1,"status":"cancelled"}\n{}\n');
    else if (outcome === "bom") process.stdout.end('\ufeff{"schemaVersion":1,"status":"cancelled"}\n');
    else if (outcome === "unc") process.stdout.end('{"schemaVersion":1,"status":"selected","path":"\\\\\\\\server\\\\share"}\n');
    else if (outcome === "relative") process.stdout.end('{"schemaVersion":1,"status":"selected","path":"Games\\\\Stardew Valley"}\n');
    else process.stdout.end('{"schemaVersion":1,"status":"selected","path":"candidate"}\n');
    process.stderr.end(outcome === "stderr" ? "secret path" : "");
    queueMicrotask(() => process.emit("close", outcome === "nonzero" ? 1 : 0, null));
  });
  return process as unknown as ChildProcess;
}

test("folder picker returns one untrusted selected candidate or cancellation", async () => {
  assert.deepEqual(await selectStardewFolder(createTestWindowsStardewFolderPicker(() => child("selected"))), { status: "selected", path: "C:\\Games\\Stardew Valley" });
  assert.deepEqual(await selectStardewFolder(createTestWindowsStardewFolderPicker(() => child("cancelled"))), { status: "cancelled" });
});

for (const outcome of ["malformed", "overflow", "stderr", "nonzero", "timeout", "extra-key", "extra-line", "bom", "unc", "relative"] as const) {
  test(`folder picker fails closed on ${outcome}`, async () => {
    await assert.rejects(selectStardewFolder(createTestWindowsStardewFolderPicker(() => child(outcome), 10)), /windows_stardew_folder_picker_unavailable/);
  });
}

test("folder picker waits for helper termination before settling a timeout", async () => {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killCalls: 0,
    kill() { this.killCalls += 1; return true; },
  });
  const result = selectStardewFolder(createTestWindowsStardewFolderPicker(() => process as unknown as ChildProcess, 5));
  let settled = false;
  void result.catch(() => { settled = true; });
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  assert.equal(process.killCalls, 1);
  assert.equal(settled, false);
  process.emit("close", null, "SIGTERM");
  await assert.rejects(result, /windows_stardew_folder_picker_unavailable/);
});

test("folder picker does not claim timeout cleanup before the helper closes", async () => {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killCalls: 0,
    kill() { this.killCalls += 1; return true; },
  });
  const result = selectStardewFolder(createTestWindowsStardewFolderPicker(() => process as unknown as ChildProcess, 5));
  const observation = await Promise.race([
    result.then(() => "resolved", () => "rejected"),
    new Promise<"pending">((resolveWait) => setTimeout(() => resolveWait("pending"), 30)),
  ]);
  assert.equal(process.killCalls, 1);
  assert.equal(observation, "pending");
});

test("folder picker fails closed on spawn failure and forged capability without path disclosure", async () => {
  const capability = createTestWindowsStardewFolderPicker(() => { throw new Error("C:\\secret"); });
  await assert.rejects(selectStardewFolder(capability), (error: unknown) => error instanceof Error && error.message === "windows_stardew_folder_picker_unavailable");
  await assert.rejects(selectStardewFolder({} as never), /windows_stardew_folder_picker_unavailable/);
});

const publishedDestination = "native/windows-stardew-folder-picker/win-x64";
const publishedHelper = "GameBuddy.WindowsStardewFolderPicker.exe";
const publishedManifest = "windows-stardew-folder-picker.manifest.json";

function inventory(helperHash: string, manifestHash: string) {
  const origin = { kind: "verified_windows_stardew_folder_picker", destination: publishedDestination, helper: publishedHelper, manifest: publishedManifest, helperSha256: helperHash };
  return { schema: "gamebuddy-host-production-inventory/v4", entries: [
    { path: `${publishedDestination}/${publishedHelper}`, type: "file", sha256: helperHash, origin },
    { path: `${publishedDestination}/${publishedManifest}`, type: "file", sha256: manifestHash, origin },
  ] };
}

async function publishedFixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "gamebuddy-folder-picker-published-")));
  const pairRoot = resolve(root, ...publishedDestination.split("/"));
  await mkdir(pairRoot, { recursive: true });
  const helperPath = resolve(pairRoot, publishedHelper);
  const manifestPath = resolve(pairRoot, publishedManifest);
  const inventoryPath = resolve(root, "production-inventory.json");
  const helperBytes = Buffer.from("fixture folder picker bytes");
  const helperHash = createHash("sha256").update(helperBytes).digest("hex");
  const manifestBytes = Buffer.from(`{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"${publishedHelper}","sha256":"${helperHash}"}\n`);
  await writeFile(helperPath, helperBytes);
  await writeFile(manifestPath, manifestBytes);
  await writeFile(inventoryPath, JSON.stringify(inventory(helperHash, createHash("sha256").update(manifestBytes).digest("hex"))));
  return { root, helperPath, inventoryPath };
}

test("published folder picker binds the exact generation inventory and rechecks before spawn", { skip: process.platform !== "win32" }, async () => {
  const fixture = await publishedFixture();
  try {
    const capability = await createPublishedWindowsStardewFolderPicker(fixture.root);
    await writeFile(fixture.helperPath, "tampered helper path must not execute");
    await assert.rejects(selectStardewFolder(capability), /windows_stardew_folder_picker_unavailable/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("published folder picker rejects duplicate and mismatched inventory origins", { skip: process.platform !== "win32" }, async () => {
  const fixture = await publishedFixture();
  try {
    const original = JSON.parse(await readFile(fixture.inventoryPath, "utf8"));
    original.entries.push(original.entries[0]);
    await writeFile(fixture.inventoryPath, JSON.stringify(original));
    await assert.rejects(createPublishedWindowsStardewFolderPicker(fixture.root), /windows_stardew_folder_picker_unavailable/);

    original.entries.pop();
    original.entries[0].origin.kind = "typescript_emit";
    await writeFile(fixture.inventoryPath, JSON.stringify(original));
    await assert.rejects(createPublishedWindowsStardewFolderPicker(fixture.root), /windows_stardew_folder_picker_unavailable/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("published folder picker rejects a linked generation inventory", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await publishedFixture();
  try {
    const outside = resolve(fixture.root, "outside-inventory.json");
    await writeFile(outside, await readFile(fixture.inventoryPath));
    await rm(fixture.inventoryPath);
    try { await symlink(outside, fixture.inventoryPath, "file"); }
    catch (error: any) { if (error?.code === "EPERM") { t.skip("Windows file symlink unavailable"); return; } throw error; }
    await assert.rejects(createPublishedWindowsStardewFolderPicker(fixture.root), /windows_stardew_folder_picker_unavailable/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
