import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(PACKAGE_DIRECTORY, "src", "wire-parity.mjs");

function runWireParity() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: PACKAGE_DIRECTORY,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

test("cross-language wire parity covers request, recovery, cancel, error, and boundaries", { timeout: 180_000 }, async () => {
  const result = await runWireParity();
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "decode_execution_request:passed",
    "decode_execution_receipt_query:passed",
    "decode_cancel_request:passed",
    "decode_error:passed",
    "encode_execution_receipt:passed",
    "encode_execution_receipt_query:passed",
    "encode_cancel_request:passed",
    "encode_error:passed",
    "malformed_json:passed",
    "oversize:passed",
    "invalid_utf8:passed",
    "invalid_version:passed",
    "invalid_type:passed",
    "invalid_casing:passed",
  ]);
  assert.equal(result.stderr, "");
});

test("wire parity runner is package-local and does not invoke live or preflight gates", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /spawn\(/);
  assert.doesNotMatch(source, /run-live|preflight/);
  assert.match(source, /stdio:\s*\[\s*["']pipe["']/);
});
