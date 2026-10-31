#!/usr/bin/env node
/**
 * The run's coverage boundary: wipe the previous run's raw data before any worker
 * starts, because a leftover `worker-N.json` from an earlier run would be merged into
 * this one and the numbers would be a mixture of two runs.
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rawDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "coverage", "raw");

export default function clearPreviousRun() {
  rmSync(rawDirectory, { recursive: true, force: true });
  mkdirSync(rawDirectory, { recursive: true });
}
