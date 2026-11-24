import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { reloadMagicContextInRuntimeRoot, withRuntimeMagicContextRoot } from "./runtime-core.internal.js";

/**
 * THE WINDOW IS THE PROCESS'S, NOT THE SCOPE'S.
 *
 * Magic Context's bootstrap pins process-wide values around its own work. Everything it pins as an environment
 * variable is restored by the scope and invisible to a reader that does not go looking for it - but the working
 * directory is different in kind: any code that resolves a RELATIVE path, spawns a child, or reads `process.cwd()`
 * while the window is open answers with the scope's runtime root instead of its own. The reading below is taken from
 * OUTSIDE the scope: a concurrent party resumes inside the window, which is what a second surface's turn, a spawned
 * `git`, or any relative path read does while the scope awaits.
 *
 * The scope used to move the directory for every holder. The session-end reflection held it across a spawned provider
 * call - measured at 8 748 ms, bounded at a minute - so this is the witness that the exit path no longer does.
 */
test("a reflection's window does not move the working directory of work outside it", async () => {
  const ambient = process.cwd();
  const runtimeCwd = mkdtempSync(join(tmpdir(), "gb-cwd-reflection-"));
  let resumeOutside: () => void = () => undefined;
  const outsideGate = new Promise<void>((resolveGate) => {
    resumeOutside = resolveGate;
  });
  const outside = (async (): Promise<string> => {
    await outsideGate;
    return process.cwd();
  })();
  try {
    const [, reading] = await Promise.all([
      withRuntimeMagicContextRoot(runtimeCwd, async () => {
        resumeOutside();
        // A real macrotask: the reflection's work is a provider call, so the gap is not a microtask in production.
        await new Promise<void>((resolveGap) => setImmediate(resolveGap));
        return "settled";
      }),
      outside,
    ]);
    assert.equal(reading, ambient, `a reflection moved the process into its own root (${runtimeCwd})`);
    assert.equal(process.cwd(), ambient);
  } finally {
    rmSync(runtimeCwd, { recursive: true, force: true });
  }
});

/**
 * The mount is the one holder that still pins the directory, and it must leave the process where it found it.
 *
 * `pi-coding-agent` hands an extension factory no project directory, and the vendored entry reads `process.cwd()`
 * there, so the mount pins it for the seconds `loader.reload()` takes (see `reloadMagicContextInRuntimeRoot`). Both
 * readings below come from one run: the window is really pinned while the loader runs, and it is released - on the
 * throwing path too, which is the half a `finally` owes and the half a reader can lose.
 */
test("a mount pins the working directory for its own load and restores it on both paths", async () => {
  const ambient = process.cwd();
  const runtimeCwd = mkdtempSync(join(tmpdir(), "gb-cwd-mount-"));
  try {
    let inside = "";
    const loader = {
      reload: async (): Promise<void> => {
        inside = process.cwd();
      },
    };
    await reloadMagicContextInRuntimeRoot(loader as unknown as DefaultResourceLoader, runtimeCwd);
    assert.equal(inside, runtimeCwd, "the mount's own load resolves the runtime root, which is what it needs");
    assert.equal(process.cwd(), ambient, "and the pin ends with the load");

    const throwing = {
      reload: async (): Promise<void> => {
        throw new Error("injected: the mount failed");
      },
    };
    await assert.rejects(
      reloadMagicContextInRuntimeRoot(throwing as unknown as DefaultResourceLoader, runtimeCwd),
      /injected/,
    );
    assert.equal(process.cwd(), ambient, "a failing mount must not park the process in the runtime root");
  } finally {
    rmSync(runtimeCwd, { recursive: true, force: true });
  }
});

/**
 * What the runtime's own files are still resolved to, whatever the process directory is.
 *
 * The two roots are named in one test on purpose: an absolute path inside the runtime root must keep reaching the
 * runtime's file, and an absolute path outside it must keep reaching that one. A scope that could pass either
 * assertion by moving the process would fail the other.
 */
test("a scope reads and writes inside its own root and outside it, both absolutely", async () => {
  const ambient = process.cwd();
  const outsideRoot = mkdtempSync(join(tmpdir(), "gb-cwd-outside-"));
  const runtimeCwd = mkdtempSync(join(tmpdir(), "gb-cwd-inside-"));
  const runtimeStore = join(runtimeCwd, "data", "cortexkit", "magic-context");
  const outsideFile = join(outsideRoot, "outside.txt");
  try {
    mkdirSync(runtimeStore, { recursive: true });
    writeFileSync(join(runtimeStore, "inside.txt"), "inside", "utf8");
    writeFileSync(outsideFile, "outside", "utf8");
    const read = await withRuntimeMagicContextRoot(runtimeCwd, async (root) => {
      // The published root IS what a caller derives its paths from, so a caller that uses it never has to resolve
      // anything relative to the process.
      assert.equal(root.storageDir, runtimeStore);
      writeFileSync(join(root.storageDir, "written.txt"), "written", "utf8");
      return Object.freeze({
        inside: readFileSync(join(root.storageDir, "inside.txt"), "utf8"),
        outside: readFileSync(outsideFile, "utf8"),
        written: readFileSync(join(runtimeStore, "written.txt"), "utf8"),
        cwd: process.cwd(),
      });
    });
    assert.equal(read.inside, "inside");
    assert.equal(read.outside, "outside");
    assert.equal(read.written, "written");
    assert.equal(read.cwd, ambient, "neither read is decided by where the process happens to stand");
  } finally {
    rmSync(runtimeCwd, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});
