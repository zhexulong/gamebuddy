import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source pins for the shared-world driver's log handling.
 *
 * Reason: the driver gave BOTH roles the machine-global SMAPI log files and deleted them at launch, so two concurrent
 * shared-world runs destroyed each other's readiness evidence -- the later launch erased the earlier one's marker, its
 * wait never matched, and the run died at its timeout while the log showed the other lane's save (measured
 * 2026-10-14). These pins make that regression structural.
 *
 * These are source pins because the behaviour they guard needs a running game to exercise: what can be checked without
 * one is that the driver still routes readiness through its OWN files and never deletes a shared one.
 */
const DRIVER = join(import.meta.dirname, "run-stardew-shared-world-action.ps1");
const source = readFileSync(DRIVER, "utf8");

test("readiness is judged from this run's own log streams first", () => {
  assert.match(source, /\$LogRoot = Join-Path \$ProbeRoot 'logs'/u);
  assert.match(source, /\$hostLog = Join-Path \$LogRoot 'host\.stdout\.log'/u);
  assert.match(source, /\$aiLog = Join-Path \$LogRoot 'ai-client\.stdout\.log'/u);
  // The shared files survive as a fallback, never as the only source.
  assert.match(source, /\$sharedHostLog = Join-Path \$env:APPDATA 'StardewValley\\ErrorLogs\\SMAPI-latest\.txt'/u);
  assert.match(source, /Wait-LogMarker @\(\$hostLog, \$sharedHostLog\)/u);
  assert.match(source, /Wait-LogMarker @\(\$aiLog, \$sharedAiLog\)/u);
});

test("both roles' console output is redirected into this run's own files", () => {
  assert.match(source, /-RedirectStandardOutput \$StdOut -RedirectStandardError \$StdErr/u);
  assert.match(source, /\$script:hostProcess = Start-Smapi \$hostModsRoot \$hostGeneration \$hostLog \$hostErrorLog/u);
  assert.match(source, /\$script:aiProcess = Start-Smapi \$aiModsRoot \$aiGeneration \$aiLog \$aiErrorLog/u);
});

test("no shared log file is deleted, because another run may be writing it", () => {
  assert.doesNotMatch(source, /Remove-Item -LiteralPath \$shared/u);
  assert.doesNotMatch(source, /Remove-Item -LiteralPath \$hostLog -Force -ErrorAction SilentlyContinue/u);
  assert.doesNotMatch(source, /Remove-Item -LiteralPath \$aiLog -Force -ErrorAction SilentlyContinue/u);
});

test("Wait-LogMarker polls every candidate it is handed", () => {
  assert.match(source, /function Wait-LogMarker\(\[string\[\]\]\$Paths,/u);
  assert.match(source, /foreach \(\$candidate in \$Paths\) \{/u);
  // A body still reading the old singular parameter would never match anything, and the driver would fail every run.
  const body = source.slice(source.indexOf("function Wait-LogMarker"), source.indexOf("function Read-Json"));
  assert.doesNotMatch(body, /\$Path\b/u);
});
