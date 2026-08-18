import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkTextHygiene, inspectText } from "./check-text-hygiene.mjs";

test("text hygiene rejects trailing whitespace, mixed endings, BOM, and missing final newline", () => {
  assert.deepEqual(inspectText("fixture.txt", Buffer.from("ok \nnext\r\nthird\n")), [
    { path: "fixture.txt", reason: "mixed_eol" },
    { path: "fixture.txt", reason: "trailing_whitespace", line: 1 },
  ]);
  assert.deepEqual(inspectText("fixture.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("text")])), [
    { path: "fixture.txt", reason: "utf8_bom" },
    { path: "fixture.txt", reason: "missing_final_newline" },
  ]);
  assert.deepEqual(inspectText("fixture.txt", Buffer.from("windows\r\nlines\r\n")), []);
  assert.deepEqual(inspectText("fixture.txt", Buffer.from([0x6f, 0x6b, 0x00, 0x0a])), [
    { path: "fixture.txt", reason: "embedded_nul" },
  ]);
});

test("text hygiene covers tracked and non-ignored untracked owned text while excluding generated, runtime, and binary roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gamebuddy-text-hygiene-"));
  try {
    await writeFile(path.join(root, "tracked.txt"), "clean\n");
    await writeFile(path.join(root, "untracked.txt"), "bad \n");
    await writeFile(path.join(root, "nul.txt"), Buffer.from([0x6f, 0x6b, 0x00, 0x0a]));
    await writeFile(path.join(root, "ignored.png"), Buffer.from([0, 1, 2]));
    await mkdir(path.join(root, "host", "contexts"), { recursive: true });
    await writeFile(path.join(root, "host", "contexts", "runtime.db"), Buffer.from([0x6f, 0x6b, 0x00, 0x0a]));
    const result = await checkTextHygiene({
      root,
      git: async (arguments_) => {
        if (arguments_.includes("--others")) return "untracked.txt\0nul.txt\0ignored.png\0host/contexts/runtime.db\0";
        return "tracked.txt\0";
      },
    });
    assert.equal(result.verdict, "blocked");
    assert.deepEqual(result.violations, [
      { path: "nul.txt", reason: "embedded_nul" },
      { path: "untracked.txt", reason: "trailing_whitespace", line: 1 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
