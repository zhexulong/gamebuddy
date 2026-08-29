import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildWindowsStardewFolderPicker, canonicalManifest, helperFileName, manifestFileName, outputRoot } from "./build-windows-stardew-folder-picker.mjs";

test("folder-picker manifest is strict and canonical", () => {
  const digest = createHash("sha256").update("fixture").digest("hex");
  assert.equal(canonicalManifest(digest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"${helperFileName}","sha256":"${digest}"}\n`);
  assert.equal(manifestFileName, "windows-stardew-folder-picker.manifest.json");
});

test("folder-picker build uses locked SDK and yields canonical fixed pair", { skip: process.platform !== "win32" }, async (t) => {
  try { const pair = await buildWindowsStardewFolderPicker(); assert.equal(pair.sha256.length, 64); }
  catch (error) { if (error instanceof Error && /dotnet_(?:missing|sdk_drift)/.test(error.message)) { t.skip(`BLOCKED: ${error.message}`); return; } throw error; }
});

test("native helper emits no stderr when its interactive process is terminated", { skip: process.platform !== "win32" }, async (t) => {
  const helper = `${outputRoot}\\${helperFileName}`; try { await access(helper); } catch { t.skip("BLOCKED: helper not built"); return; }
  // Protocol is output-only: helper accepts no stdin/request/config fallback.
  const child = spawn(helper, [], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const stderr = []; child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.kill(); await new Promise((resolve) => child.once("close", resolve));
  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});
