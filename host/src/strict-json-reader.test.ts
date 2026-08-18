import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { readStrictJsonFile, STRICT_JSON_READER_MAX_BUDGET_BYTES } from "./strict-json-reader.js";

const execFileAsync = promisify(execFile);

async function runWithMockedFilesystem(
  mode: "same_size_replacement" | "lstat_failure" | "read_failure",
  path: string,
): Promise<void> {
  const readerUrl = new URL("./strict-json-reader.js", import.meta.url).href;
  const script = `
    import * as filesystem from "node:fs/promises";
    import { mock } from "node:test";
    const [readerUrl, targetPath, mode] = process.argv.slice(1);
    const overrides = mode === "lstat_failure"
      ? { lstat: async () => { throw new Error("sensitive stat detail"); } }
      : { open: async (...args) => {
          const handle = await filesystem.open(...args);
          const read = handle.read.bind(handle);
          let mutated = false;
          handle.read = async (...readArgs) => {
            if (mode === "read_failure") throw new Error("sensitive read detail");
            const result = await read(...readArgs);
            if (!mutated) {
              mutated = true;
              await filesystem.writeFile(targetPath, '{"value":"after!"}', "utf8");
            }
            return result;
          };
          return handle;
        } };
    await mock.module("node:fs/promises", { namedExports: { ...filesystem, ...overrides } });
    const { readStrictJsonFile } = await import(readerUrl + "?controlled-filesystem");
    try {
      await readStrictJsonFile(targetPath);
      process.exitCode = 1;
    } catch (error) {
      if (error?.message !== "invalid_strict_json_file") process.exitCode = 1;
    }
  `;
  await execFileAsync(process.execPath, [
    "--experimental-test-module-mocks",
    "--input-type=module",
    "--eval",
    script,
    readerUrl,
    path,
    mode,
  ]);
}

async function fixture(): Promise<{ root: string; path: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-strict-json-reader-"));
  return { root, path: join(root, "input.json"), dispose: () => rm(root, { recursive: true, force: true }) };
}

async function rejects(contents: string | Buffer): Promise<void> {
  const subject = await fixture();
  try {
    await writeFile(subject.path, contents);
    await assert.rejects(readStrictJsonFile(subject.path), { message: "invalid_strict_json_file" });
  } finally {
    await subject.dispose();
  }
}

test("strict JSON reader returns valid parsed JSON", async () => {
  const subject = await fixture();
  try {
    await writeFile(subject.path, '{"nested":[true,null,{"count":2}]}', "utf8");
    assert.deepEqual(await readStrictJsonFile(subject.path), { nested: [true, null, { count: 2 }] });
  } finally {
    await subject.dispose();
  }
});

test("strict JSON reader rejects malformed, trailing, and duplicate decoded keys", async () => {
  await rejects("{not-json");
  await rejects('{"key":1,"k\\u0065y":2}');
  await rejects('{"value":1} trailing');
  await rejects("[".repeat(33) + "0" + "]".repeat(33));
});

test("strict JSON reader rejects a UTF-8 BOM explicitly", async () => {
  await rejects(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
});

test("strict JSON reader accepts bounded high-cardinality valid JSON", async () => {
  const subject = await fixture();
  try {
    const entries = Array.from({ length: 4_000 }, (_, index) => `"key_${index}":${index}`).join(",");
    await writeFile(subject.path, `{${entries}}`, "utf8");
    const parsed = await readStrictJsonFile(subject.path);
    assert.equal(Object.keys(parsed as object).length, 4_000);
  } finally {
    await subject.dispose();
  }
});

test("strict JSON reader rejects a same-size replacement during its read", async () => {
  const subject = await fixture();
  try {
    await writeFile(subject.path, '{"value":"before"}', "utf8");
    await runWithMockedFilesystem("same_size_replacement", subject.path);
  } finally {
    await subject.dispose();
  }
});

test("strict JSON reader rejects invalid UTF-8 and files over its bounded limit", async () => {
  await rejects(Buffer.from([0xff]));
  const subject = await fixture();
  try {
    await writeFile(subject.path, "{}", "utf8");
    await truncate(subject.path, 65_537);
    await assert.rejects(readStrictJsonFile(subject.path), { message: "invalid_strict_json_file" });
  } finally {
    await subject.dispose();
  }
});

test("strict JSON reader rejects non-files and symbolic links", async (t) => {
  const subject = await fixture();
  const target = join(subject.root, "target.json");
  const link = join(subject.root, "link.json");
  try {
    await assert.rejects(readStrictJsonFile(subject.root), { message: "invalid_strict_json_file" });
    await writeFile(target, "{}", "utf8");
    try {
      await symlink(target, link, "file");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        t.skip("symbolic links are not permitted in this environment");
        return;
      }
      throw error;
    }
    await assert.rejects(readStrictJsonFile(link), { message: "invalid_strict_json_file" });
  } finally {
    await subject.dispose();
  }
});

test("strict JSON reader accepts a caller-selected byte budget exactly at its boundary", async () => {
  const subject = await fixture();
  try {
    const budget = 1024;
    const pad = "a".repeat(budget - 10);
    await writeFile(subject.path, `{"pad":"${pad}"}`, "utf8");
    const parsed = await readStrictJsonFile(subject.path, budget);
    assert.equal((parsed as { pad: string }).pad, pad);
    // One byte over the same caller-selected budget fails closed.
    await writeFile(subject.path, `{"pad":"${pad}x"}`, "utf8");
    await assert.rejects(readStrictJsonFile(subject.path, budget), { message: "invalid_strict_json_file" });
  } finally {
    await subject.dispose();
  }
});

test("strict JSON reader reads large explicit budgets without dropping strictness", async () => {
  const subject = await fixture();
  try {
    const budget = 1024 * 1024;
    const pad = "b".repeat(budget - 10);
    await writeFile(subject.path, `{"pad":"${pad}"}`, "utf8");
    const parsed = await readStrictJsonFile(subject.path, budget);
    assert.equal((parsed as { pad: string }).pad.length, pad.length);
    // The same file is rejected under the conservative default budget.
    await assert.rejects(readStrictJsonFile(subject.path), { message: "invalid_strict_json_file" });
  } finally {
    await subject.dispose();
  }
});

test("strict JSON reader rejects caller budgets outside the frozen envelope", async () => {
  const subject = await fixture();
  try {
    await writeFile(subject.path, "{}", "utf8");
    for (const budget of [0, -1, 1.5, Number.NaN, STRICT_JSON_READER_MAX_BUDGET_BYTES + 1]) {
      await assert.rejects(readStrictJsonFile(subject.path, budget), { message: "invalid_strict_json_budget" });
    }
    // An invalid budget never falls back to an unbounded read.
    assert.deepEqual(await readStrictJsonFile(subject.path), {});
  } finally {
    await subject.dispose();
  }
});

test("strict JSON reader redacts stat and read failures", async () => {
  const subject = await fixture();
  try {
    await writeFile(subject.path, "{}", "utf8");
    await runWithMockedFilesystem("lstat_failure", subject.path);
    await runWithMockedFilesystem("read_failure", subject.path);
  } finally {
    await subject.dispose();
  }
});
