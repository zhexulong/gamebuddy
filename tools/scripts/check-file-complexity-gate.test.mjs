/**
 * 复杂度棘轮的判定，用植入用例试出来。
 *
 * 这个门禁只有在两件事上都试红过才值得存在：一是"文件本来就大"和"你让它变大"分得清，二是它的样本来自扫描 -
 * 一个基准清单从没听说过的文件也必须被量到。纯判定用例覆盖分类本身，fixture 用例跑真实脚本确认失败码与退出码。
 */
// red-proof: inject  `lines > ceiling` widened to `lines >= ceiling` in verdict -> a file exactly at its
//                    extension's ceiling is reported over it and the suite answers `✖ verdict.2:` (11 pass,
//                    1 fail), exit 1; the unmodified suite answers 12 passing
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanOutputLines } from "../lib/subprocess-output.mjs";
import { CEILINGS_BY_EXTENSION, measure, verdict } from "./check-file-complexity-gate.mjs";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const GATE = join(SCRIPTS_ROOT, "check-file-complexity-gate.mjs");
const MJS_CEILING = CEILINGS_BY_EXTENSION.get(".mjs");
const TS_CEILING = CEILINGS_BY_EXTENSION.get(".ts");
const BASELINE = ["tools", "scripts", "file-complexity-baseline.json"];

const sizesOf = (entries) => new Map(Object.entries(entries));

test("verdict.1: 基准从没听说过的文件超过本扩展名上限，失败码点名路径、行数和上限", () => {
  const result = verdict({ recorded: {}, sizes: sizesOf({ "src/giant.mjs": 3000 }) });
  assert.deepEqual(result.overCeiling, [{ file: "src/giant.mjs", lines: 3000, ceiling: MJS_CEILING }]);
  assert.deepEqual(result.grew, []);
  assert.deepEqual(result.stale, []);
});

test("verdict.2: 界在扩展名上 - 正好等于上限不算超，多一行才算，且同一行数在 .ts 里不算超", () => {
  const sizes = sizesOf({ "src/exactly.mjs": MJS_CEILING, "src/long.ts": MJS_CEILING });
  assert.deepEqual(verdict({ recorded: {}, sizes }).overCeiling, []);
  assert.ok(MJS_CEILING < TS_CEILING, "两个扩展名的上限必须不同，否则按扩展名分上限没有意义");
  sizes.set("src/exactly.mjs", MJS_CEILING + 1);
  assert.deepEqual(
    verdict({ recorded: {}, sizes }).overCeiling.map((entry) => entry.file),
    ["src/exactly.mjs"],
  );
});

test("verdict.3: 已登记的文件本来就大不算失败 - 只有变大才失败", () => {
  const sizes = sizesOf({ "src/giant.mjs": 3000 });
  assert.deepEqual(verdict({ recorded: { "src/giant.mjs": 3000 }, sizes }).grew, []);
  assert.deepEqual(verdict({ recorded: { "src/giant.mjs": 3000 }, sizes }).overCeiling, []);
});

test("verdict.4: 已登记的文件加一行，失败的就是它，并报出记录值", () => {
  const result = verdict({ recorded: { "src/giant.mjs": 3000 }, sizes: sizesOf({ "src/giant.mjs": 3001 }) });
  assert.deepEqual(result.grew, [{ file: "src/giant.mjs", lines: 3001, recorded: 3000, ceiling: MJS_CEILING }]);
  assert.deepEqual(result.overCeiling, [], "已登记的文件报 grew，不重复报 over_ceiling");
});

test("verdict.5: 已登记的文件回到上限之内是 stale - 基准只许收紧", () => {
  const result = verdict({ recorded: { "src/giant.mjs": 3000 }, sizes: sizesOf({ "src/giant.mjs": MJS_CEILING }) });
  assert.deepEqual(
    result.stale.map((entry) => entry.file),
    ["src/giant.mjs"],
  );
});

test("verdict.6: 已登记的文件消失也是 stale，不是通过", () => {
  const result = verdict({ recorded: { "src/gone.mjs": 3000 }, sizes: sizesOf({ "src/other.ts": 10 }) });
  assert.deepEqual(
    result.stale.map((entry) => entry.file),
    ["src/gone.mjs"],
  );
});

const writeLines = (path, count) => writeFileSync(path, "// line\n".repeat(count - 1));

const commit = (root) => {
  const identity = ["-c", "user.name=complexity-ratchet", "-c", "user.email=complexity-ratchet@example.invalid"];
  execFileSync("git", [...identity, "add", "-A"], { cwd: root, windowsHide: true, stdio: "ignore" });
  execFileSync("git", [...identity, "commit", "-m", "fixture"], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  });
};

/** 一个 git 工作树：样本由 git 自己回答，所以 fixture 必须是一个仓库。 */
const fixture = ({ files = {}, baseline = {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "gb-complexity-ratchet-"));
  for (const [file, path] of Object.entries({ "src/keep.ts": 10, ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeLines(join(root, file), path);
  }
  mkdirSync(dirname(join(root, ...BASELINE)), { recursive: true });
  writeFileSync(
    join(root, ...BASELINE),
    `${JSON.stringify({ note: "fixture", revision: "0000000", sizes: baseline }, null, 2)}\n`,
  );
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, windowsHide: true, stdio: "ignore" });
  commit(root);
  return root;
};

const withFixture = (run, options) => {
  const root = fixture(options);
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
};

const runGate = (root, ...args) =>
  spawnSync(process.execPath, [GATE, "--root", root, ...args], { encoding: "utf8", windowsHide: true });

test("planted.A: 一个基准从没听说过的 3000 行文件 - 未提交也要被量到，并被点名", () => {
  withFixture((root) => {
    writeLines(join(root, "src", "giant.mjs"), 3000);
    const result = runGate(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(
      result.stdout.includes(`files examined 2 · over ceiling 1 · baselined 0 · largest src/giant.mjs @ 3000`),
      result.stdout,
    );
    assert.ok(result.stderr.includes(`file_over_ceiling:src/giant.mjs:3000:${MJS_CEILING}`), result.stderr);
    process.stdout.write(
      `planted.A: 3000/${MJS_CEILING} unknown to the baseline -> ${cleanOutputLines(result.stderr).find((line) => line.startsWith("file_over_ceiling"))}\n`,
    );
  });
});

test("planted.B: --update 记下它之后通过，再长一行就红在 baselined_file_grew", () => {
  withFixture((root) => {
    writeLines(join(root, "src", "giant.mjs"), 3000);
    assert.equal(runGate(root).status, 1);
    const updated = runGate(root, "--update");
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.match(updated.stdout, /complexity_ratchet_recorded files=1/u);
    assert.equal(runGate(root).status, 0);
    writeFileSync(join(root, "src", "giant.mjs"), `${readFileSync(join(root, "src", "giant.mjs"), "utf8")}// grows\n`);
    const grown = runGate(root);
    assert.equal(grown.status, 1);
    assert.match(grown.stderr, /baselined_file_grew:src\/giant\.mjs:3001:3000/u);
    process.stdout.write(
      `planted.B: recorded 3000 -> 3001 -> ${cleanOutputLines(grown.stderr).find((line) => line.startsWith("baselined_file_grew"))}\n`,
    );
  });
});

test("planted.C: 已登记的文件瘦身回到上限之内，基准条目必须删掉（stale，exit 1）", () => {
  withFixture(
    (root) => {
      const result = runGate(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /stale_file_ceiling_baseline:src\/giant\.mjs/u);
      assert.equal(runGate(root, "--update").status, 0);
      assert.equal(runGate(root).status, 0, "重新记录后清空该条目");
    },
    { baseline: { "src/giant.mjs": 3000 } },
  );
});

test("planted.D: 一个文件都没量到是 BLOCKED（exit 2），不是通过", () => {
  withFixture((root) => {
    rmSync(join(root, "src"), { recursive: true, force: true });
    writeFileSync(join(root, "notes.md"), "# 没有可量的源码\n");
    const result = runGate(root);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /status=blocked file_complexity_population_empty/u);
    process.stdout.write(`planted.D: 0 examined -> exit 2\n`);
  });
});

test("planted.E: 每个扩展名的贡献与上限都打印出来，未设上限的扩展名也点名", () => {
  withFixture((root) => {
    writeFileSync(join(root, "notes.json"), "{}\n");
    const result = runGate(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`.ts 1 个文件 · 上限 ${TS_CEILING} 行`), result.stdout);
    // 两处：刚写的 notes.json 和 fixture 自己的基准文件。
    assert.match(result.stdout, /未设上限（不参与判定）：\.json 2/u);
  });
});

test("planted.F: 门禁的默认 root 是本仓库，扫描读到真实源码而不是一张清单", () => {
  const repositoryRoot = resolve(SCRIPTS_ROOT, "..", "..");
  const { sizes, extensions } = measure(repositoryRoot);
  assert.ok(sizes.size > 1000, `扫描应读到整个仓库的源码，实际 ${sizes.size} 个文件`);
  for (const [, count] of extensions) assert.ok(count > 0);
  for (const file of sizes.keys())
    assert.ok(CEILINGS_BY_EXTENSION.has(file.slice(file.lastIndexOf("."))), `${file} 的扩展名没有上限`);
  assert.ok(extensions.size >= 5, `上限表里至少五种扩展名应在树里出现，实际 ${[...extensions.keys()].join(",")}`);
});
