import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, ".dependency-cruiser.dialogue-web.cjs");
const config = require(configPath);

/**
 * Golden zone manifest — path patterns, not a file list, and the single
 * authority for which layer a source file belongs to. The same patterns are
 * the zone constants in `.dependency-cruiser.dialogue-web.cjs`, and the first
 * test below fails if the two ever drift apart.
 *
 * Chat, Chats, Characters, Game, Settings, Memory and World Info are peer
 * surfaces, so every `components/*Surface.tsx` belongs to the `surface` layer
 * the moment it is added. A file that matches no pattern fails
 * `every dialogue-web/src file belongs to exactly one golden zone` — that is
 * the property that stops a new surface from escaping the boundary rules
 * silently.
 */
const ZONES = {
  chatContract:
    "^dialogue-web/src/reference-pipeline-(api|session)\\.ts$",
  platformContract:
    "^dialogue-web/src/(management-pipeline-(api|session)|composed-reference-game-browser-api)\\.ts$",
  composedRoot: "^dialogue-web/src/components/ComposedReferenceGameApp\\.tsx$",
  surface: "^dialogue-web/src/components/[^/]*Surface\\.tsx$",
  surfaceSupport:
    "^dialogue-web/src/((game-(lifecycle-controls|presentation)|composed-problem-view|pi-settings-model)\\.ts|components/(CharacterCardImport|CharactersPanel|CharactersSurfacePanel|GameDiagnosticsDisclosure|GameStatePanel|StardewInstallationDiscovery|SurfaceModelSettings|composed-reference-game-view|management-panels|management-surface-panels|character-domain-labels|memory-notebook-labels|png-character-card)\\.tsx?)$",
  sharedUi:
    "^dialogue-web/src/(components/(MessageBubble|Timeline|ProblemView|SkipLink|Composer|MarkdownMessage|SurfaceView|AppBar|ContextDrawer)\\.tsx|components/drawers/ChatsDrawer\\.tsx)$",
  shared: "^dialogue-web/src/(i18n|types)\\.ts$",
};

/**
 * Current drift ledger — must be empty. The surfaces are peers that own
 * independent lifecycles; shared access is limited to the wire contracts and
 * props-driven presentation primitives. Any new cross-surface edge, contract
 * impurity, or UI primitive depending on a surface fails this check.
 */
const DRIFT_LEDGER = [];

function depcruiseBin() {
  const pkgDir = join(repoRoot, "node_modules", "dependency-cruiser");
  const packageJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin.depcruise;
  return join(pkgDir, bin);
}

function runDepcruise(cwd, configPathArg, input) {
  const result = spawnSync(process.execPath, [depcruiseBin(), "--config", configPathArg, "--output-type", "json", input], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, `depcruise failed to start: ${result.error?.message ?? ""}`);
  const parsed = JSON.parse(result.stdout || "{}");
  return {
    violations: (parsed.summary?.violations ?? []).map((v) => [v.rule?.name, v.from, v.to]),
    exitCode: result.status,
  };
}

function collectSourceFiles() {
  const srcRoot = join(repoRoot, "dialogue-web", "src");
  const files = [];
  const walk = (dir) => {
    for (const entry of readDirectory(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(relative(srcRoot, full).replaceAll("\\", "/"));
    }
  };
  walk(srcRoot);
  return files;
}

function readDirectory(dir) {
  const { readdirSync } = require("node:fs");
  return readdirSync(dir, { withFileTypes: true });
}

function splitTopLevel(input, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function zoneAlternatives(rulePath) {
  let stripped = rulePath;
  if (stripped.startsWith("(")) {
    let depth = 0;
    let outerClose = -1;
    for (let index = 0; index < stripped.length; index += 1) {
      if (stripped[index] === "(") depth += 1;
      else if (stripped[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          outerClose = index;
          break;
        }
      }
    }
    if (outerClose === stripped.length - 1) stripped = stripped.slice(1, -1);
  }
  return splitTopLevel(stripped, "|");
}

test("zone rules reference only known zones and every zone is guarded", () => {
  const zoneStrings = Object.values(ZONES);
  for (const rule of config.forbidden) {
    for (const side of [rule.from?.path, rule.to?.path]) {
      assert.ok(side, `rule ${rule.name} has a missing from/to path`);
      for (const alternative of zoneAlternatives(side)) {
        assert.ok(zoneStrings.includes(alternative), `rule ${rule.name} references unknown zone ${alternative}`);
      }
    }
  }
  const referenced = new Set(config.forbidden.flatMap((rule) => [rule.from.path, rule.to.path]));
  for (const zone of zoneStrings) {
    assert.ok([...referenced].some((path) => path.includes(zone) || path === zone), `zone ${zone} is not referenced by any rule`);
  }
  assert.equal(config.options.includeOnly, "^dialogue-web/src/");
});

test("every dialogue-web/src file belongs to exactly one golden zone", () => {
  const allFiles = collectSourceFiles();
  assert.ok(allFiles.includes("main.tsx"), "main.tsx shell must exist");
  for (const file of allFiles) {
    if (file === "main.tsx") continue; // shell assembler is intentionally unzoned
    const matches = Object.entries(ZONES).filter(([, pattern]) => new RegExp(pattern).test(`dialogue-web/src/${file}`));
    assert.equal(matches.length, 1, `file ${file} matches ${matches.length} zones: ${matches.map(([name]) => name).join(",")}`);
  }
});

test("current cross-surface drift is exactly the documented ledger", () => {
  const { violations } = runDepcruise(repoRoot, configPath, "dialogue-web/src/main.tsx");
  const actual = violations.map(([rule, from, to]) => [rule, from, to].join("|")).sort();
  const expected = DRIFT_LEDGER.map(([rule, from, to]) => [rule, from, to].join("|")).sort();
  assert.deepEqual(actual, expected, "cross-surface drift differs from the documented ledger — new violations must be fixed, ledger entries must only shrink via deliberate decoupling changes");
});

test("boundary rules actually fire on a fixture violating every direction", () => {
  const fixture = mkdtempSync(join(tmpdir(), "gamebuddy-boundary-"));
  try {
    writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({ compilerOptions: { moduleResolution: "node" }, include: ["src/**/*"] }));
    const write = (rel, content) => {
      const full = join(fixture, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    // --- contracts ---
    // chat contract must not import any surface or shared UI.
    write("src/reference-pipeline-api.ts", 'import "./components/ChatSurface";\n');
    // its own members must not import each other.
    write("src/reference-pipeline-session.ts", 'import "./reference-pipeline-api";\n');
    write("src/management-pipeline-api.ts", "");
    write("src/composed-reference-game-browser-api.ts", "");
    // --- composed root: the one assembler ---
    write("src/components/ComposedReferenceGameApp.tsx", "");
    // --- surfaces: peer body must not import another peer body ---
    write("src/components/ChatSurface.tsx", 'import "./GameSurface";\n');
    write("src/components/GameSurface.tsx", "");
    // --- surface-support must not depend on a surface ---
    write("src/components/management-panels.tsx", 'import "./ChatSurface";\n');
    // --- shared-ui must not import a surface or its support ---
    write("src/components/SurfaceView.tsx", 'import "./ChatSurface";\n');
    // --- shared leaf must not import a surface either ---
    write("src/i18n.ts", 'import "./components/ChatSurface";\n');

    const rebased = { ...structuredClone(config), options: { ...structuredClone(config.options), includeOnly: "^src/", tsConfig: { fileName: join(fixture, "tsconfig.json") } } };
    for (const rule of rebased.forbidden) {
      rule.from.path = rule.from.path.replaceAll("^dialogue-web/src/", "^src/");
      rule.to.path = rule.to.path.replaceAll("^dialogue-web/src/", "^src/");
    }
    const fixtureConfig = join(fixture, "depcruise.config.json");
    writeFileSync(fixtureConfig, JSON.stringify(rebased));

    const { violations } = runDepcruise(fixture, fixtureConfig, "src");
    const rulesFired = new Set(violations.map(([rule]) => rule));
    assert.deepEqual(
      [...rulesFired].sort(),
      ["no-chat-contract-internal-dependency", "no-contract-imports-ui", "no-shared-imports-modules", "no-shared-ui-imports-surfaces", "no-surface-support-to-surface", "no-surface-to-other-surface"].sort(),
      `fixture must fire every boundary rule; fired: ${[...rulesFired].join(",")}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
