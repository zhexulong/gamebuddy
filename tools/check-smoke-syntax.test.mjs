import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const script = resolve(import.meta.dirname, "run-stardew-agent-game-smoke.mjs");

async function check(path) {
  try {
    await execFile(process.execPath, ["--check", path], { windowsHide: true });
    return { code: 0, output: "" };
  } catch (error) {
    return { code: error.code, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("the owned Stardew Agent smoke entry parses", async () => {
  const result = await check(script);
  assert.equal(result.code, 0, result.output);
});

test("a modelConfig punctuation regression fails the syntax gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-smoke-syntax-"));
  try {
    const source = await readFile(script, "utf8");
    const valid = 'provider: "cpa-oai", modelId, thinkingLevel: "high"';
    assert.ok(source.includes(valid), "expected owned syntax-gate mutation anchor");
    const fixture = join(directory, "run-stardew-agent-game-smoke.mjs");
    await writeFile(fixture, source.replace(valid, 'provider: "cpa-oai" modelId, thinkingLevel: "high"'));
    const result = await check(fixture);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /SyntaxError/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
