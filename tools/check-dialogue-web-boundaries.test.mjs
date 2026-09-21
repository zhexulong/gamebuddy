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
 * Golden zone manifest — the single authority for which files belong to
 * which surface. Any rename must update both this manifest and the config.
 */
const ZONES = {
  chatContract:
    "^dialogue-web/src/reference-pipeline-api\\.ts$",
  chatRuntime:
    "^dialogue-web/src/(reference-pipeline-session\\.ts|components/(ReferenceApp|Composer|MessageBubble|Timeline|ProblemView|SkipLink|drawers/ChatsDrawer)\\.tsx)$",
  management:
    "^dialogue-web/src/(management-pipeline-(api|session)\\.ts|components/ManagementApp\\.tsx)$",
  gameSurface:
    "^dialogue-web/src/(composed-reference-game-browser-api\\.ts|components/(ComposedReferenceGameApp|StardewInstallationDiscovery)\\.tsx)$",
  shared: "^dialogue-web/src/(i18n|types)\\.ts$",
};

const GOLDEN = {
  chatContract: ["reference-pipeline-api.ts"],
  chatRuntime: [
    "reference-pipeline-session.ts",
    "components/ReferenceApp.tsx",
    "components/Composer.tsx",
    "components/MessageBubble.tsx",
    "components/Timeline.tsx",
    "components/ProblemView.tsx",
    "components/SkipLink.tsx",
    "components/drawers/ChatsDrawer.tsx",
  ],
  management: [
    "management-pipeline-api.ts",
    "management-pipeline-session.ts",
    "components/ManagementApp.tsx",
  ],
  gameSurface: [
    "composed-reference-game-browser-api.ts",
    "components/ComposedReferenceGameApp.tsx",
    "components/StardewInstallationDiscovery.tsx",
  ],
  shared: ["i18n.ts", "types.ts"],
};

/**
 * Current drift ledger — cross-surface edges that Loop 2 (ChatPane/GamePane
 * decoupling) must cut. The check fails on ANY violation outside this exact
 * ledger, and on any ledger entry that disappears (ledger must be shrunk
 * deliberately in the same change that cuts the edge).
 */
const DRIFT_LEDGER = [
  ["no-game-surface-to-chat-side", "dialogue-web/src/components/ComposedReferenceGameApp.tsx", "dialogue-web/src/components/Composer.tsx"],
  ["no-game-surface-to-chat-side", "dialogue-web/src/components/ComposedReferenceGameApp.tsx", "dialogue-web/src/components/ProblemView.tsx"],
  ["no-game-surface-to-chat-side", "dialogue-web/src/components/ComposedReferenceGameApp.tsx", "dialogue-web/src/components/SkipLink.tsx"],
  ["no-game-surface-to-chat-side", "dialogue-web/src/components/ComposedReferenceGameApp.tsx", "dialogue-web/src/components/Timeline.tsx"],
  ["no-game-surface-to-chat-side", "dialogue-web/src/components/ComposedReferenceGameApp.tsx", "dialogue-web/src/reference-pipeline-session.ts"],
];

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
  const goldenAll = new Set(Object.entries(GOLDEN).flatMap(([zone, files]) => files.map((file) => `${zone}:${file}`)));
  for (const file of allFiles) {
    if (file === "main.tsx") continue; // shell assembler is intentionally unzoned
    const matches = Object.entries(ZONES).filter(([, pattern]) => new RegExp(pattern).test(`dialogue-web/src/${file}`));
    assert.equal(matches.length, 1, `file ${file} matches ${matches.length} zones: ${matches.map(([name]) => name).join(",")}`);
    assert.ok(goldenAll.has(`${matches[0][0]}:${file}`), `file ${file} matched zone ${matches[0][0]} but is not in its golden list`);
  }
  assert.ok(allFiles.includes("main.tsx"), "main.tsx shell must exist");
  for (const [zone, files] of Object.entries(GOLDEN)) {
    for (const file of files) {
      assert.ok(new RegExp(ZONES[zone]).test(`dialogue-web/src/${file}`), `golden ${zone}/${file} no longer matches its zone pattern`);
    }
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
    // contract imports a game module → no-contract-imports-surfaces
    write("src/reference-pipeline-api.ts", 'import "./components/ComposedReferenceGameApp";\n');
    // chat runtime → game → no-chat-side-to-game-surface
    write("src/reference-pipeline-session.ts", 'import "./reference-pipeline-api";\n');
    write("src/components/Composer.tsx", 'import "../reference-pipeline-session";\n');
    write("src/components/ReferenceApp.tsx", 'import "./ComposedReferenceGameApp";\n');
    write("src/components/MessageBubble.tsx", "");
    write("src/components/Timeline.tsx", "");
    write("src/components/ProblemView.tsx", "");
    write("src/components/SkipLink.tsx", "");
    write("src/components/drawers/ChatsDrawer.tsx", "");
    // game → chat runtime + management → game
    write("src/components/ComposedReferenceGameApp.tsx", 'import "../reference-pipeline-session";\n');
    write("src/components/StardewInstallationDiscovery.tsx", 'import "../reference-pipeline-api";\n');
    write("src/management-pipeline-api.ts", "");
    write("src/management-pipeline-session.ts", "");
    write("src/components/ManagementApp.tsx", 'import "./ComposedReferenceGameApp";\n');
    // shared → chat runtime
    write("src/i18n.ts", 'import "./reference-pipeline-session";\n');
    write("src/types.ts", "");

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
      ["no-chat-side-to-game-surface", "no-contract-imports-surfaces", "no-game-surface-to-chat-side", "no-shared-imports-surfaces"].sort(),
      `fixture must fire all four surrogate rules; fired: ${[...rulesFired].join(", ")}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});