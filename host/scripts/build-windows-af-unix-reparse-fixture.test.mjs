import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  buildWindowsAfUnixReparseFixture,
  helperFileName,
  outputRoot,
  projectFile,
} from "./build-windows-af-unix-reparse-fixture.mjs";

test("AF_UNIX fixture builder is fixed to the repository project and output", async () => {
  assert.match(projectFile, /native[\\/]windows-af-unix-reparse-fixture[\\/]GameBuddy\.WindowsAfUnixReparseFixture\.csproj$/);
  assert.match(outputRoot, /native[\\/]windows-af-unix-reparse-fixture[\\/]\.dist[\\/]win-x64$/);
  assert.equal(helperFileName, "GameBuddy.WindowsAfUnixReparseFixture.exe");
  const source = await readFile(resolve(dirname(projectFile), "Program.cs"), "utf8");
  assert.match(source, /AddressFamily\.Unix/);
  assert.match(source, /UnixDomainSocketEndPoint/);
  assert.match(source, /Console\.Out\.Write\("ready\\n"\)/);
});

test("AF_UNIX fixture builder blocks explicitly off Windows", async () => {
  if (process.platform === "win32") return;
  await assert.rejects(buildWindowsAfUnixReparseFixture, /af_unix_fixture_windows_required/);
});
