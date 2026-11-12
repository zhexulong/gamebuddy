/**
 * The dialogue-web layering, measured rather than listed.
 *
 * `.dependency-cruiser.dialogue-web.cjs` holds the boundary rules and
 * `.dependency-cruiser.dialogue-web.zones.cjs` derives the zones they are built from - the
 * assembler from the browser entry, the surfaces from the filename convention, the wire
 * contracts from the modules that declare themselves one. This suite measures that
 * population, proves every rule fires on a fixture, and holds the drift ledger.
 *
 * Every proof below was seen red on a copy of the tree outside the repository and green again once
 * the injection was removed.
 *
 * red-proof: inject  a new module importing a surface -> `no-module-to-surface` names it and both
 *   ends (`zone-probe.ts -> components/ZoneProbeSurface.tsx`), because the cruiser reads the whole
 *   tree rather than the entry
 * red-proof: inject  a surface that also declares a wire contract -> `module <name> is claimed by 2
 *   zones (<zone>,<zone>): one module, one zone`, where the zones a module is claimed by are read
 *   from the same declaration the contract list is
 * red-proof: inject  both chat wire-contract declarations deleted -> the run stops with `no module
 *   declares a chat wire contract: the contract zone is read from the declarations, so an empty one
 *   is a blocked reading rather than a gate that agrees with itself`
 * red-proof: inject  the fixture below loses its cycle pair -> `the fixture must fire every rule the
 *   config declares` names the rule it could no longer fire, so a rule that stopped firing cannot
 *   pass as one the fixture never needed
 * red-proof: inject  `import "./components/ChatSurface"` added to game-lifecycle-controls.ts ->
 *   `✖ current cross-surface drift is exactly the documented ledger`, found `no-module-to-surface`
 *   naming game-lifecycle-controls.ts and components/ChatSurface.tsx, exit 1
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, ".dependency-cruiser.dialogue-web.cjs");
const config = require(configPath);
const { SRC, ZONES, assembler, contracts, sourceModules } = require(
  join(repoRoot, ".dependency-cruiser.dialogue-web.zones.cjs"),
);

/**
 * The zones a single module can be CLAIMED by. `components` is a target group rather than
 * a classification, and `module` is the residual - every file is in it by subtraction - so
 * neither can conflict with another.
 */
const MODULE_ZONES = ["assembler", "surface", "chatContract", "platformContract"];

/**
 * Current drift ledger - must be empty. The surfaces are peers that own independent
 * lifecycles; the wire contracts and the assembler are the only modules that may be
 * shared across them. Any new cross-surface edge, or a browser module reaching back
 * across a contract, fails this check.
 */
const DRIFT_LEDGER = [];

const inZone = (zone, relativePath) => new RegExp(ZONES[zone]).test(`${SRC}/${relativePath}`);

function depcruiseBin() {
  const pkgDir = join(repoRoot, "node_modules", "dependency-cruiser");
  const packageJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin.depcruise;
  return join(pkgDir, bin);
}

/**
 * The verdict comes from what the cruiser printed, not from its exit code: it exits
 * non-zero while reporting violations, so an unparsed run is a BLOCKED reading and has to
 * fail as one rather than pass as an empty violation list.
 */
function runDepcruise(cwd, configPathArg, input) {
  const result = spawnSync(
    process.execPath,
    [depcruiseBin(), "--config", configPathArg, "--output-type", "json", input],
    {
      cwd,
      encoding: "utf8",
    },
  );
  assert.equal(result.error, undefined, `depcruise failed to start: ${result.error?.message ?? ""}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "");
  } catch {
    assert.fail(`depcruise printed no cruise result: ${(result.stdout + result.stderr).trim().slice(0, 2000)}`);
  }
  assert.ok(parsed.summary, `depcruise reported no summary: ${(result.stdout + result.stderr).trim().slice(0, 2000)}`);
  assert.ok(Array.isArray(parsed.modules), "depcruise reported no modules: nothing was cruised");
  return {
    violations: (parsed.summary.violations ?? []).map((v) => [v.rule?.name, v.from, v.to]),
    modules: parsed.modules,
  };
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

test("the boundary rules are built from the tree's own zones, and every zone is guarded", () => {
  const zoneStrings = Object.values(ZONES);
  const referenced = new Set();
  for (const rule of config.forbidden) {
    for (const side of [rule.from, rule.to]) {
      for (const selector of [side?.path, side?.pathNot]) {
        if (selector === undefined) continue;
        for (const alternative of zoneAlternatives(selector)) referenced.add(alternative);
      }
    }
    assert.ok(rule.from?.path, `rule ${rule.name} has a missing from path`);
    assert.ok(rule.to?.path ?? rule.to?.circular === true, `rule ${rule.name} has a missing to path`);
  }
  for (const alternative of referenced)
    assert.ok(zoneStrings.includes(alternative), `rule references a zone the tree does not derive: ${alternative}`);
  for (const zone of zoneStrings) assert.ok(referenced.has(zone), `zone ${zone} is derived but guarded by no rule`);
  assert.equal(
    config.options.includeOnly,
    ZONES.module,
    "the cruiser must cruise exactly the modules the gate reports on",
  );
});

test("every module lands in exactly one zone, and no declaration contradicts the structure", (t) => {
  const modules = sourceModules();
  assert.ok(modules.length > 0, `${SRC} holds no module: a gate whose population is empty agrees with itself`);
  assert.ok(modules.includes(assembler), `the assembler ${assembler} is not a module under ${SRC}`);
  for (const module of modules) {
    const claimed = MODULE_ZONES.filter((zone) => inZone(zone, module));
    assert.ok(
      claimed.length <= 1,
      `module ${module} is claimed by ${claimed.length} zones (${claimed.join(",")}): one module, one zone`,
    );
  }
  // The assembler is the one module exempt from `no-module-to-surface`, so it must not itself
  // be a surface - that would exempt a surface from the rule that composes it.
  assert.ok(
    !inZone("surface", assembler),
    `the assembler ${assembler} is a surface: an exempt surface composes itself`,
  );
  // A contract that is a component IS the edge `no-contract-imports-components` forbids.
  for (const [flavour, declared] of Object.entries(contracts))
    for (const module of declared)
      assert.ok(
        !inZone("components", module),
        `the ${flavour} wire contract ${module} is a component: a wire contract that renders is inside the boundary it defines`,
      );
  const surfaces = modules.filter((module) => inZone("surface", module));
  const contractCount = contracts.chat.length + contracts.platform.length;
  t.diagnostic(
    `examined ${modules.length} modules under ${SRC}: ${surfaces.length} surface(s), 1 assembler (${assembler}), ` +
      `${contractCount} declared wire contract(s), ${modules.length - surfaces.length - contractCount - 1} module(s) on the residual rules`,
  );
});

test("current cross-surface drift is exactly the documented ledger", () => {
  // The whole tree, not the entry: a cruiser started at `main.tsx` sees only what the entry
  // reaches, so a module nothing imports yet would sit outside every rule - the escape hatch this
  // gate exists to close, one import away from being a live cross-surface edge.
  const { violations } = runDepcruise(repoRoot, configPath, SRC);
  const actual = violations.map(([rule, from, to]) => [rule, from, to].join("|")).sort();
  const expected = DRIFT_LEDGER.map(([rule, from, to]) => [rule, from, to].join("|")).sort();
  assert.deepEqual(
    actual,
    expected,
    "cross-surface drift differs from the documented ledger — new violations must be fixed, ledger entries must only shrink via deliberate decoupling changes.\n" +
      `  found:  ${actual.join("\n          ") || "(none)"}\n` +
      `  ledger: ${expected.join("\n          ") || "(none)"}`,
  );
});

test("every boundary rule fires on a fixture that violates it", () => {
  const fixture = mkdtempSync(join(tmpdir(), "gamebuddy-boundary-"));
  try {
    writeFileSync(
      join(fixture, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { moduleResolution: "node" }, include: ["src/**/*"] }),
    );
    const write = (rel, content) => {
      const full = join(fixture, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    // The fixture is written at the paths the real zones name, so the rules that fire here are
    // the rules the tree gets: the assembler, the surfaces and the contracts are the derived ones.
    write(`src/${assembler}`, "");
    const [chatContract, otherChatContract] = contracts.chat;
    const [platformContract] = contracts.platform;
    for (const contract of [...contracts.chat, ...contracts.platform]) write(`src/${contract}`, "");
    // a module that is not the assembler importing a surface
    write("src/leaf.ts", 'import "./components/ChatSurface";\n');
    write("src/components/ChatSurface.tsx", "");
    // the chat contract's own members importing each other
    write(`src/${otherChatContract}`, `import "./${chatContract.replace(/\.ts$/, "")}";\n`);
    // a contract reaching a component through an intermediate module: transitivity is the rule
    write(`src/${platformContract}`, 'import "./intermediate";\n');
    write("src/intermediate.ts", 'import "./components/Composer";\n');
    write("src/components/Composer.tsx", "");
    // a cycle between two ordinary modules
    write("src/cycle-one.ts", 'import "./cycle-two";\n');
    write("src/cycle-two.ts", 'import "./cycle-one";\n');

    const rebased = structuredClone(config);
    rebased.options.includeOnly = "^src/";
    rebased.options.tsConfig = { fileName: join(fixture, "tsconfig.json") };
    for (const rule of rebased.forbidden) {
      for (const side of [rule.from, rule.to]) {
        for (const key of ["path", "pathNot"]) {
          if (typeof side[key] === "string") side[key] = side[key].replaceAll(`^${SRC}/`, "^src/");
        }
      }
    }
    const fixtureConfig = join(fixture, "depcruise.config.json");
    writeFileSync(fixtureConfig, JSON.stringify(rebased));

    const { violations } = runDepcruise(fixture, fixtureConfig, "src");
    const rulesFired = new Set(violations.map(([rule]) => rule));
    assert.deepEqual(
      [...rulesFired].sort(),
      config.forbidden.map((rule) => rule.name).sort(),
      `the fixture must fire every rule the config declares: it fired ${[...rulesFired].join(",") || "none"}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
