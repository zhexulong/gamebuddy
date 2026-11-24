import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stopChildGracefully } from "./child-shutdown.mjs";

/**
 * A real child that takes its owner's channel as the quit: it stays up until its standard input
 * ends, writes the fact that it ran its own shutdown path, and leaves with code 0.
 *
 * The marker is the point. "It exited" would also be true of a process this harness killed, which
 * is exactly the difference the memory loop's second phase depends on.
 */
const OBEYS_THE_CHANNEL = `
const { appendFileSync } = require("node:fs");
process.stdin.on("end", () => {
  appendFileSync(process.env.SHUTDOWN_MARKER, "channel-end\\n");
  process.exitCode = 0;
});
process.stdin.resume();
`;

/** A real child that will not listen: only the escalation can end this one. */
const IGNORES_THE_CHANNEL = `
process.stdin.on("data", () => {});
setInterval(() => {}, 1000);
`;

async function withMarker(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-child-shutdown-"));
  try {
    return await run(join(root, "marker.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function spawnFakeChild(script, marker) {
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SHUTDOWN_MARKER: marker },
  });
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  return { child, exited };
}

function settleWithin(promise, milliseconds) {
  return Promise.race([
    promise,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), milliseconds)),
  ]);
}

test("the close request ends a child that watches the owner channel, on its own path", async () => {
  await withMarker(async (marker) => {
    const { child, exited } = spawnFakeChild(OBEYS_THE_CHANNEL, marker);
    const started = Date.now();
    await stopChildGracefully(child);
    const outcome = await settleWithin(exited, 5_000);
    const elapsed = Date.now() - started;

    assert.ok(outcome !== undefined, "the child had not left 5 000 ms after the request");
    assert.equal(outcome.code, 0, "the child must leave by its own path, not by the escalation");
    assert.equal(outcome.signal, null);
    // The child's own testimony: it read the end of its standard input, which is the product's quit.
    assert.equal(await readFile(marker, "utf8"), "channel-end\n");
    // The bound is a budget, not a latency assertion: a request that had to escalate would show
    // the caller's full timeout here instead of the child's own exit.
    assert.ok(elapsed < 30_000, `the request spent its whole timeout (${elapsed} ms)`);
  });
});

test("the close request kills a child that will not take the channel", async () => {
  await withMarker(async (marker) => {
    const { child, exited } = spawnFakeChild(IGNORES_THE_CHANNEL, marker);
    const started = Date.now();
    await stopChildGracefully(child, 400);
    const elapsed = Date.now() - started;
    const outcome = await settleWithin(exited, 5_000);

    assert.ok(outcome !== undefined, "the escalation did not end the child");
    // The reading that separates the two paths: this child never ran a shutdown path of its own.
    await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
    assert.ok(elapsed >= 400, `the escalation fired before the declared wait (${elapsed} ms)`);
  });
});
