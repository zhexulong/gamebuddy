import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";

test("native-local launchers use a non-invasive named-pipe namespace lookup instead of opening the single-client bridge", async () => {
  const helper = await readFile(new URL("./lib/stardew-named-pipe-readiness.ps1", import.meta.url), "utf8");
  assert.match(helper, /Directory\]::GetFiles\('/);
  assert.match(helper, /GetFileName\(/);
  assert.match(helper, /-ceq \$PipeName/);
  assert.doesNotMatch(helper, /NamedPipeClientStream|\.Connect\(|Write|ReadFrame|BridgeToken|navigation_read_request/);

  for (const launcher of [
    "./run-stardew-native-local-player-move-fixture.ps1",
    "./run-stardew-native-local-player-navigation-read-only-fixture.ps1",
  ]) {
    const source = await readFile(new URL(launcher, import.meta.url), "utf8");
    assert.match(source, /stardew-named-pipe-readiness\.ps1/);
    assert.match(source, /Test-GameBuddyNamedPipeListening -PipeName \$pipeName/);
    assert.doesNotMatch(source, /Test-Path -LiteralPath "\\\\\.\\pipe\\\$pipeName"/);
  }
});

test("named-pipe readiness probe reports false for a missing listener", async () => {
  const scriptPath = new URL("./lib/stardew-named-pipe-readiness.ps1", import.meta.url).pathname.replace(/^\//, "");
  const command = [
    `& { . '${scriptPath.replaceAll("'", "''")}';`,
    "if (Test-GameBuddyNamedPipeListening -PipeName 'gamebuddy-pipe-that-does-not-exist') { exit 1 }",
    "}",
  ].join(" ");
  const result = await runPowerShell(command);
  assert.equal(result.code, 0, result.stderr);
});

test("named-pipe readiness lookup sees a live listener without opening its single client slot", async () => {
  const scriptPath = new URL("./lib/stardew-named-pipe-readiness.ps1", import.meta.url).pathname.replace(/^\//, "");
  const pipeName = `gamebuddy-readiness-${process.pid}-${Date.now()}`;
  const command = [
    `& { . '${scriptPath.replaceAll("'", "''")}';`,
    `$server = [System.IO.Pipes.NamedPipeServerStream]::new('${pipeName}', [System.IO.Pipes.PipeDirection]::InOut, 1);`,
    "try {",
    `if (-not (Test-GameBuddyNamedPipeListening -PipeName '${pipeName}')) { exit 1 }`,
    "if ($server.IsConnected) { exit 2 }",
    "} finally { $server.Dispose() }",
    "}",
  ].join(" ");
  const result = await runPowerShell(command);
  assert.equal(result.code, 0, result.stderr);
});

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}
