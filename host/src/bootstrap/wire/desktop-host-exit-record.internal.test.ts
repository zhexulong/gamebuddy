import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import test from "node:test";

import type { DesktopHostReclamationStepOutcome } from "../../composition/desktop-host-reclamation.js";
import {
  buildDesktopHostExitRecord,
  DESKTOP_HOST_EXIT_RECORD_DIRECTORY,
  DESKTOP_HOST_EXIT_RECORD_SCHEMA,
  desktopHostExitRecordFileName,
  isBoundedExitToken,
  recordDesktopHostExit,
} from "./desktop-host-exit-record.internal.js";

const steps: readonly DesktopHostReclamationStepOutcome[] = [
  { step: "stop_admission", status: "completed", failure: null },
  { step: "drain_chat_runtime", status: "failed", failure: "bridge_session_unavailable" },
  { step: "release_voice_client", status: "not_applicable", failure: null },
];

test("the exit record is the one bounded shape: reason, pid, time and per-step outcomes only", () => {
  const record = buildDesktopHostExitRecord({
    kind: "incomplete_exit",
    reason: "bridge_session_unavailable",
    pid: 4242,
    recordedAtUnixMs: 1_760_000_000_000,
    steps,
  });

  assert.equal(record.schema, DESKTOP_HOST_EXIT_RECORD_SCHEMA);
  assert.equal(record.version, 1);
  assert.equal(record.kind, "incomplete_exit");
  assert.equal(record.reason, "bridge_session_unavailable");
  assert.equal(record.pid, 4242);
  assert.equal(record.recordedAtUnixMs, 1_760_000_000_000);
  // Exactly these keys, in this order: a new key here is a new disclosure surface.
  assert.deepEqual(Object.keys(record), ["schema", "version", "kind", "reason", "pid", "recordedAtUnixMs", "steps"]);
  assert.deepEqual(record.steps, [
    { step: "stop_admission", status: "completed", failure: null },
    { step: "drain_chat_runtime", status: "failed", failure: "bridge_session_unavailable" },
    { step: "release_voice_client", status: "not_applicable", failure: null },
  ]);
  assert.equal(DESKTOP_HOST_EXIT_RECORD_DIRECTORY, "host-exit");
});

test("a reason or failure that is not a bounded token is replaced, so a path or credential can never reach the record", () => {
  const record = buildDesktopHostExitRecord({
    kind: "crash",
    reason: "E:\\projects\\ai-game-companion\\bridge-token=abc123",
    pid: 1,
    recordedAtUnixMs: 0,
    steps: [
      { step: "drain_game_lifecycle", status: "failed", failure: "C:\\Users\\player\\secret pipe name" },
      { step: "SESSION LOST" as never, status: "failed", failure: "bearer 0123456789abcdef" },
    ],
  });

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("bridge-token"), false);
  assert.equal(serialized.includes("secret pipe name"), false);
  assert.equal(serialized.includes("bearer"), false);
  assert.equal(serialized.includes("E:\\"), false);
  assert.equal(record.reason, "desktop_host_exit_unattributed");
  assert.equal(record.steps[0]?.failure, null);
  assert.equal(record.steps[1]?.step, "unknown_step");
  assert.equal(record.steps[1]?.failure, null);

  assert.equal(isBoundedExitToken("clean_exit"), true);
  assert.equal(isBoundedExitToken("bridge_disconnected:pipe_gone"), true);
  assert.equal(isBoundedExitToken("has space"), false);
  assert.equal(isBoundedExitToken("Uppercase"), false);
  assert.equal(isBoundedExitToken(""), false);
});

test("the file name sorts chronologically and carries the pid", () => {
  const record = buildDesktopHostExitRecord({ kind: "crash", reason: "clean_exit", pid: 7, recordedAtUnixMs: 0, steps: [] });
  assert.equal(desktopHostExitRecordFileName(record), "host-exit-1970-01-01T00-00-00-000Z-7.json");
});

test("writing a record creates its directory and returns the exact path it wrote", async (t) => {
  if (process.platform !== "win32") return t.skip("the operational root and its record path are Windows-shaped");
  const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-exit-"));
  try {
    const directory = join(fixtureRoot, "GameBuddy", "operational", DESKTOP_HOST_EXIT_RECORD_DIRECTORY);
    const path = await recordDesktopHostExit(directory, {
      kind: "crash",
      reason: "desktop_runtime_bootstrap_unavailable",
      pid: 99,
      recordedAtUnixMs: 1_760_000_000_000,
      steps,
    });
    assert.equal(typeof path, "string");
    assert.deepEqual(await readdir(directory), [desktopHostExitRecordFileName(buildDesktopHostExitRecord({ kind: "crash", reason: "desktop_runtime_bootstrap_unavailable", pid: 99, recordedAtUnixMs: 1_760_000_000_000, steps }))]);
    const written = JSON.parse((await readFile(path!, "utf8")).trim()) as Record<string, unknown>;
    assert.equal(written.schema, DESKTOP_HOST_EXIT_RECORD_SCHEMA);
    assert.equal(written.reason, "desktop_runtime_bootstrap_unavailable");
    assert.equal(written.pid, 99);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
