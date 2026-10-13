/**
 * 复杂度棘轮的判定，用两个植入用例试出来。
 *
 * 棘轮只有在"文件本来就大"和"你让它变大"之间真的分得清时，才值得替换掉一个永远红的绝对上限门禁。
 * 纯判定用例覆盖分类本身，fixture 用例跑真实脚本确认退出码。
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CEILINGS, limits, measure, ratchet } from "./check-file-complexity-gate.mjs";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const GATE = join(SCRIPTS_ROOT, "check-file-complexity-gate.mjs");
const [MOD_ENTRY, FIXTURES, STORE, PROTOCOL] = [...CEILINGS.keys()];

// 四个文件在 HEAD 都已超上限；这正是旧门禁永远红、没人读的原因。
const OVER_CEILING = { [MOD_ENTRY]: 2887, [FIXTURES]: 5338, [STORE]: 5042, [PROTOCOL]: 5564 };
const UNDER_CEILING = { "dialogue-web/src/components/ComposedReferenceGameApp.tsx": 1247 };
const sizesOf = (entries) => new Map(Object.entries(entries));

test("ratchet.1: 植入用例 B - 四个文件仍超上限，但都没变大，门禁通过", () => {
  const sizes = sizesOf({ ...OVER_CEILING, ...UNDER_CEILING });
  const recorded = Object.fromEntries(sizes);
  const result = ratchet({ recorded, sizes });
  assert.deepEqual(result.grown, []);
  assert.deepEqual(result.missing, []);
  for (const [file, ceiling] of CEILINGS)
    if (OVER_CEILING[file] !== undefined) assert.ok(sizes.get(file) > ceiling, `${file} 应超上限`);
});

test("ratchet.2: 植入用例 A - 只给其中一个文件加一行，失败的就是它", () => {
  const sizes = sizesOf({ ...OVER_CEILING, ...UNDER_CEILING });
  const recorded = Object.fromEntries(sizes);
  sizes.set(MOD_ENTRY, OVER_CEILING[MOD_ENTRY] + 1);
  const result = ratchet({ recorded, sizes });
  assert.deepEqual(
    result.grown.map((entry) => entry.file),
    [MOD_ENTRY],
  );
  assert.equal(result.grown[0].lines, 2888);
  assert.equal(result.grown[0].limit, 2887);
});

test("ratchet.3: 记录基准才让绝对上限之外的判定生效 - 空基准就是四个文件全红", () => {
  const sizes = sizesOf({ ...OVER_CEILING, ...UNDER_CEILING });
  const result = ratchet({ recorded: {}, sizes });
  assert.deepEqual(
    result.grown.map((entry) => entry.file),
    [MOD_ENTRY, FIXTURES, STORE, PROTOCOL],
    "没有基准时回落为绝对上限",
  );
});

test("ratchet.4: 未破上限的文件对上限于上限为止，和旧门禁一致", () => {
  const file = "dialogue-web/src/components/ComposedReferenceGameApp.tsx";
  const sizes = sizesOf({ ...OVER_CEILING, [file]: 1300 });
  assert.deepEqual(ratchet({ recorded: { ...OVER_CEILING, [file]: 1247 }, sizes }).grown, []);
  sizes.set(file, 1451);
  assert.deepEqual(
    ratchet({ recorded: { ...OVER_CEILING, [file]: 1247 }, sizes }).grown.map((entry) => entry.file),
    [file],
  );
});

test("ratchet.5: 已登记却读不到的文件是失败，不是通过", () => {
  const sizes = sizesOf({ ...OVER_CEILING, ...UNDER_CEILING });
  sizes.set(PROTOCOL, undefined);
  const result = ratchet({ recorded: Object.fromEntries(Object.entries(OVER_CEILING)), sizes });
  assert.deepEqual(result.missing, [PROTOCOL]);
});

test("limits.1: 判定上限是绝对上限与已记录行数中较大的那个", () => {
  const computed = limits({ recorded: { [MOD_ENTRY]: 2887, [FIXTURES]: 10 } });
  assert.equal(computed.get(MOD_ENTRY), 2887);
  assert.equal(computed.get(FIXTURES), 4500, "记录值低于绝对上限时以上限为准");
});

const writeLines = (path, count) => writeFileSync(path, "// line\n".repeat(count - 1));

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "gb-complexity-ratchet-"));
  for (const [file, count] of Object.entries({ ...OVER_CEILING, ...UNDER_CEILING })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeLines(join(root, file), count);
  }
  mkdirSync(join(root, "tools", "scripts"), { recursive: true });
  writeFileSync(
    join(root, "tools", "scripts", "file-complexity-baseline.json"),
    `${JSON.stringify({ note: "fixture", revision: "0000000", sizes: { ...OVER_CEILING, ...UNDER_CEILING } }, null, 2)}\n`,
  );
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, windowsHide: true, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=complexity-ratchet", "-c", "user.email=complexity-ratchet@example.invalid", "add", "-A"],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
  execFileSync(
    "git",
    [
      "-c",
      "user.name=complexity-ratchet",
      "-c",
      "user.email=complexity-ratchet@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
  return root;
};

const withFixture = (run) => {
  const root = fixture();
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
};

const runGate = (root, ...args) =>
  spawnSync(process.execPath, [GATE, "--root", root, ...args], { encoding: "utf8", windowsHide: true });

test("planted.B: 四个超上限文件原封不动，fixture 门禁通过并公布债务", () => {
  withFixture((root) => {
    const result = runGate(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /复杂度棘轮通过/);
    assert.match(result.stdout, /ModEntry\.cs 2887\/2800/);
    process.stdout.write(
      `planted.B: 2887/2800 unchanged -> ${result.status === 0 ? "exit 0" : "exit " + result.status}\n`,
    );
  });
});

test("planted.A: 同一个 fixture 只加一行，门禁失败并指出是它变大了", () => {
  withFixture((root) => {
    writeFileSync(join(root, MOD_ENTRY), `${readFileSync(join(root, MOD_ENTRY), "utf8")}// grows\n`);
    const result = runGate(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✖ integrations\/stardew\/ModEntry\.cs: 2888 行/);
    assert.match(result.stderr, /2887 -> 2888 行/);
    process.stdout.write(
      `planted.A: 2887 -> 2888 -> ${result.stderr.split("\n").find((line) => line.includes("->"))}\n`,
    );
  });
});

test("planted.C: --update 重新记录后再次通过", () => {
  withFixture((root) => {
    writeFileSync(join(root, MOD_ENTRY), `${readFileSync(join(root, MOD_ENTRY), "utf8")}// grows\n`);
    assert.equal(runGate(root).status, 1);
    const updated = runGate(root, "--update");
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.match(updated.stdout, /complexity_ratchet_recorded files=5/);
    assert.equal(runGate(root).status, 0);
  });
});

test("planted.D: 门禁的默认 root 是本仓库，measure 读到真实的五个核心文件", () => {
  const repositoryRoot = resolve(SCRIPTS_ROOT, "..", "..");
  const sizes = measure(repositoryRoot);
  assert.deepEqual([...sizes.keys()], [...CEILINGS.keys()]);
  for (const [, count] of sizes) assert.ok(count > 0);
});
