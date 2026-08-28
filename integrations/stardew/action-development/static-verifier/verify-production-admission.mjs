#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseJsonWithoutDuplicateKeys } from "../src/json-text.mjs";
import { validateProductionReport } from "./production-schema.mjs";

const STATIC_VERIFIER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_PRODUCTION_SCRIPT = path.join(STATIC_VERIFIER_DIRECTORY, "verify-production.mjs");
const DEFAULT_MANIFEST = "current.json";
const MAX_REPORT_BYTES = 1024 * 1024;

function fail(code) {
  throw new Error(`stardew_static_production_admission_${code}`);
}

export function runProductionStaticAdmission({
  spawnProcess = spawn,
  manifest = DEFAULT_MANIFEST,
} = {}) {
  if (typeof spawnProcess !== "function") fail("invalid_spawn");
  if (manifest !== DEFAULT_MANIFEST) fail("invalid_manifest");

  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [VERIFY_PRODUCTION_SCRIPT, manifest], {
      cwd: STATIC_VERIFIER_DIRECTORY,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_REPORT_BYTES) overflow = true;
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_REPORT_BYTES) overflow = true;
      else stderr.push(chunk);
    });
    child.once("error", () => reject(new Error("stardew_static_production_admission_spawn_failed")));
    child.once("close", (code, signal) => {
      try {
        if (overflow) fail("output_too_large");
        if (signal !== null || stderrBytes !== 0) fail("process_failed");
        if (code !== 0 && code !== 2) fail("process_failed");
        const text = Buffer.concat(stdout).toString("utf8");
        const report = validateProductionReport(parseJsonWithoutDuplicateKeys(text, "stardew_static_production_admission"));
        if (code === 0 && report.state !== "passed") fail("state_mismatch");
        if (code === 2 && report.state !== "blocked") fail("state_mismatch");
        resolve(report);
      } catch (error) {
        reject(error);
      }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProductionStaticAdmission().then(
    (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
