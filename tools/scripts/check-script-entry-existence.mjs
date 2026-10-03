// check-script-entry-existence.mjs — 门禁：package.json scripts 引用的仓库内文件必须存在。
// 防"幽灵入口"（如 test:unit 指向已删除的 main-entry.test.mjs 被 node --test 静默放行）。
// 只检查明确以仓库相对路径（tools/、scripts/、tests/、src/、integrations/、fixtures/ 开头）出现的引用；
// 命令名（pnpm/node/dotnet/tsc 等）、glob、shell 语法片段不检查。
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KNOWN_LEADERS = ["tools/", "host/", "dialogue-web/", "packages/", "integrations/", "fixtures/", "scripts/", ".github/"];
const PATHISH = /(?:^|\s)(?:"?)((?:tools|host|dialogue-web|packages|integrations|fixtures|scripts|\.github)\/[^\s"'`|&;<>()]+)/g;

function collectScripts(pkgRoot) {
  const pkgPath = join(pkgRoot, "package.json");
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return Object.entries(pkg.scripts || {}).map(([name, cmd]) => ({ name, cmd, pkgRoot }));
}

function resolveRef(rootDir, ref) {
  // 去掉尾部引号/分号/重定向残留
  const clean = ref.replace(/["'`]$/, "");
  if (/[*?[\]]/.test(clean)) return null; // glob，跳过
  const full = resolve(rootDir, clean);
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st) return null; // 不存在
  return full;
}

const problems = [];
const checked = [];
for (const dir of ["", "host", "dialogue-web", "packages/voice-protocol", "packages/game-action-program", "integrations/stardew/action-development", "voice-gateway"]) {
  for (const { name, cmd, pkgRoot } of collectScripts(join(root, dir))) {
    for (const m of cmd.matchAll(PATHISH)) {
      const ref = m[1];
      if (!KNOWN_LEADERS.some((k) => ref.startsWith(k))) continue;
      const found = resolveRef(pkgRoot || root, ref);
      if (found) checked.push(ref);
      else problems.push({ script: `${dir || "."}:${name}`, ref });
    }
  }
}

if (problems.length) {
  console.error("幽灵脚本入口（package.json scripts 引用了不存在的文件）:");
  for (const p of problems) console.error(`  ${p.script} → ${p.ref}`);
  process.exit(1);
}
console.log(`check-script-entry-existence: ${checked.length} 个路径引用全部存在 ✓`);