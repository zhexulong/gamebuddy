// red-proof: inject  silencing the `assembler_names_credential_file` push in Arm B -> 3 cases red, the first
//   `AssertionError: Expected values to be strictly deep-equal: + [] - [['assembler_names_credential_file',
//   'diagnostic-bundle.mjs', 'auth.json']]` at tools/check-credential-export-isolation.test.mjs:190
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  credentialContainer,
  credentialPayloadPopulation,
  credentialPopulation,
  credentialWrites,
  destinationSuffixes,
  evaluate,
  exportRouteIds,
  isProductionTs,
  isShipped,
  liveSecretFields,
  patternArrays,
} from "./check-credential-export-isolation.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-credential-export-isolation.mjs");

/**
 * The module the population is derived from, reduced to the shape that matters: an exported path
 * builder over a `.json` constant, in a module that writes a file.
 */
const STORE = `import { join } from "node:path";
const AUTH_FILE = "auth.json";
const CONNECTION_KEYS_FILE = "tavern-connection-keys.json";
const CONNECTION_DOCUMENT_FILE = "tavern-connections.json";
export function connectionDocumentPath(agentDir: string): string {
  return join(agentDir, CONNECTION_DOCUMENT_FILE);
}
export function connectionAuthPath(agentDir: string): string {
  return join(agentDir, AUTH_FILE);
}
export function connectionKeysPath(agentDir: string): string {
  return join(agentDir, CONNECTION_KEYS_FILE);
}
export async function write(next: Record<string, unknown>, agentDir: string): Promise<void> {
  await atomicWriteFile(connectionAuthPath(agentDir), JSON.stringify(next));
  await atomicWriteFile(connectionKeysPath(agentDir), JSON.stringify(next));
}
`;

/**
 * The runtime's own layout, reduced the same way. `credentialContainer` reads these two joins, so a
 * fixture that omitted this file would be testing the gate's own fallback rather than the rule.
 */
const RUNTIME_IDENTITY = `import { join } from "node:path";
export function resolveRuntimePaths(identity: unknown, root = join("h", ".gamebuddy")): RuntimePaths {
  const key = identityKey(identity);
  const resolvedRoot = resolve(root);
  const runtimeCwd = join(resolvedRoot, "contexts", key);
  return {
    runtimeCwd,
    agentDir: join(runtimeCwd, "pi-agent"),
  };
}
`;

/** Every fixture root: the credential store, the runtime layout, and whatever the case adds. */
function fixture(files) {
  return {
    "host/src/tavern/connection-store.ts": STORE,
    "host/src/runtime-identity.ts": RUNTIME_IDENTITY,
    ...files,
  };
}

function withFixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "gb-credential-export-"));
  try {
    for (const [relativePath, contents] of Object.entries(fixture(files))) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    return evaluate({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the population is derived from the path builders, not from a filename list", () => {
  const { credentials, violations } = withFixtureRoot({});
  assert.deepEqual(violations, []);
  assert.deepEqual(
    credentials.map((entry) => `${entry.builder}:${entry.leaf}`),
    ["connectionAuthPath:auth.json", "connectionKeysPath:tavern-connection-keys.json"],
  );
});

test("the credential container is read from the runtime's own resolver, not restated here", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-credential-container-"));
  try {
    const path = join(root, "host/src/runtime-identity.ts");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, RUNTIME_IDENTITY);
    assert.equal(credentialContainer(root), "contexts/<key>/pi-agent");
    rmSync(path);
    assert.equal(credentialContainer(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable runtime layout fails instead of silently narrowing the tree-filter arm", () => {
  const { violations } = withFixtureRoot({ "host/src/runtime-identity.ts": "export const moved = 1;\n" });
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["credential_container_unresolved"],
  );
});

test("a third credential store declared the same way joins the population with no edit to the gate", () => {
  const { credentials } = withFixtureRoot({
    "host/src/tavern/second-store.ts": `import { join } from "node:path";
const CREDENTIAL_CACHE_FILE = "auth-cache.json";
export function credentialCachePath(agentDir: string): string {
  return join(agentDir, CREDENTIAL_CACHE_FILE);
}
export async function write(agentDir: string): Promise<void> {
  await atomicWriteFile(credentialCachePath(agentDir), "{}");
}
`,
  });
  assert.deepEqual(
    credentials.map((entry) => entry.leaf),
    ["auth.json", "tavern-connection-keys.json", "auth-cache.json"],
  );
});

test("a builder whose leaf is not a durable document is drift, not a credential", () => {
  const { violations } = withFixtureRoot({
    "host/src/tavern/odd.ts": `import { join } from "node:path";
const TOKEN_DIRECTORY = "tokens";
export function credentialTokenPath(root: string): string {
  return join(root, TOKEN_DIRECTORY);
}
export async function write(root: string): Promise<void> {
  await atomicWriteFile(credentialTokenPath(root), "{}");
}
`,
  });
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["credential_leaf_not_a_document"],
  );
});

test("a builder that declares a credential path but writes no file is drift", () => {
  const { violations } = withFixtureRoot({
    "host/src/tavern/read-only.ts": `import { join } from "node:path";
const SECRET_FILE = "secret.json";
export function secretFilePath(root: string): string {
  return join(root, SECRET_FILE);
}
`,
  });
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["credential_file_never_written"],
  );
});

test("an empty population fails instead of passing vacuously", () => {
  const { violations } = withFixtureRoot({
    "host/src/tavern/connection-store.ts": "export const x = 1;\n",
  });
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["credential_population_empty"],
  );
});

test("an artifact assembler that names a credential file is the violation the gate exists for", () => {
  const { violations } = withFixtureRoot({
    "tools/diagnostic-bundle.mjs": `import { copyFile } from "node:fs/promises";
import { join } from "node:path";
export async function bundle(agentDir, out) {
  for (const name of ["identity-profile.json", "auth.json"]) {
    await copyFile(join(agentDir, name), join(out, name));
  }
}
`,
  });
  assert.deepEqual(
    violations.map((violation) => [violation.code, violation.file, violation.literal]),
    [["assembler_names_credential_file", "tools/diagnostic-bundle.mjs", "auth.json"]],
  );
});

test("a credential filename mentioned only in a comment is documentation, not a violation", () => {
  const { violations } = withFixtureRoot({
    "tools/live-run/core/capture.mjs": `import { copyFile } from "node:fs/promises";
// The agent directory's auth.json is deliberately not in the evidence set below.
const AGENT_EVIDENCE = Object.freeze([/^contexts\\/[^/]+\\/identity-profile\\.json$/]);
export async function captureTree(root) {
  for (const pattern of AGENT_EVIDENCE) await copyFile(root, "out");
}
`,
  });
  assert.deepEqual(violations, []);
});

test("an artifact assembler that calls a credential path builder is the same violation", () => {
  const { violations } = withFixtureRoot({
    "host/scripts/export-logs.mjs": `import { copyFile } from "node:fs/promises";
import { connectionKeysPath } from "../../host/src/tavern/connection-store.js";
export async function exportLogs(agentDir, out) {
  await copyFile(connectionKeysPath(agentDir), out);
}
`,
  });
  assert.deepEqual(
    violations.map((violation) => [violation.code, violation.builder]),
    [["assembler_calls_credential_builder", "connectionKeysPath"]],
  );
});

test("an include filter that admits a credential path is the violation, even without naming the file", () => {
  const { violations } = withFixtureRoot({
    "tools/live-run/core/capture.mjs": `import { copyFile } from "node:fs/promises";
const AGENT_EVIDENCE = Object.freeze([
  /^contexts\\/[^/]+\\/pi-agent\\/[^/]+\\.json$/,
  /^contexts\\/[^/]+\\/identity-profile\\.json$/,
]);
export async function captureTree(root) {
  for (const pattern of AGENT_EVIDENCE) await copyFile(root, "out");
}
`,
  });
  assert.deepEqual(
    violations.map((violation) => [violation.code, violation.filter, violation.leaves]),
    [
      [
        "assembler_filter_matches_credential_path",
        "AGENT_EVIDENCE: /^contexts\\/[^/]+\\/pi-agent\\/[^/]+\\.json$/",
        ["auth.json", "tavern-connection-keys.json"],
      ],
    ],
  );
});

test("a declared include set that leaves the credential files out passes", () => {
  const { violations, checked } = withFixtureRoot({
    "tools/live-run/core/capture.mjs": `import { copyFile } from "node:fs/promises";
const RUNTIME_ROOT_EVIDENCE = Object.freeze([
  /^contexts\\/[^/]+\\/identity-profile\\.json$/,
  /^contexts\\/[^/]+\\/worldbook\\.json$/,
]);
export async function captureTree(root) {
  for (const pattern of RUNTIME_ROOT_EVIDENCE) await copyFile(root, "out");
}
`,
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(checked, { credentials: 2, payloadWrites: 0, assemblers: 1, filters: 1 });
});

test("an export route id makes the module serving it an assembler", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-credential-export-routes-"));
  try {
    for (const [relativePath, contents] of Object.entries(
      fixture({
        "host/src/tavern-management-dialogue-web.ts": `const MANAGEMENT_CHAT_EXPORT_ROUTES = ["chat.export"] as const;\nexport const routes = MANAGEMENT_CHAT_EXPORT_ROUTES;\n`,
        "host/src/tavern/browser-contract/index.ts": `export const TavernBrowserContractV1 = { routes: [{ routeId: "chat.export" }, { routeId: "chat.list" }] };\n`,
      }),
    )) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    assert.deepEqual(exportRouteIds(root), ["chat.export"]);
    const { violations, assemblers } = evaluate({ root });
    assert.deepEqual(
      assemblers.map((entry) => entry.file),
      ["host/src/tavern-management-dialogue-web.ts", "host/src/tavern/browser-contract/index.ts"],
    );
    assert.deepEqual(violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a filter array that mixes regexes with anything else is not read as a filter", () => {
  const { violations } = withFixtureRoot({
    "tools/mixed.mjs": `import { copyFile } from "node:fs/promises";
const MIXED = Object.freeze([/^contexts\\//, "identity-profile.json"]);
export async function go(root) {
  for (const entry of MIXED) await copyFile(root, "out");
}
`,
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(patternArrays("const MIXED = [/a/, 'b'];\n"), []);
});

test("pattern arrays are read through strings and comments", () => {
  const arrays = patternArrays(`// a regex in a comment: [/auth\\.json/]
const OUTSIDE = Object.freeze([
  // the identity profile, not a credential
  /^contexts\\/[^/]+\\/identity-profile\\.json$/,
  /^contexts\\/[^/]+\\/pi-agent\\/[^/]+\\.json$/,
]);
`);
  assert.equal(arrays.length, 1);
  assert.equal(arrays[0].name, "OUTSIDE");
  assert.equal(arrays[0].patterns.length, 2);
  assert.equal(arrays[0].patterns[1].pattern.test("contexts/k0/pi-agent/auth.json"), true);
});

test("only shipped code is scanned: tests, fixtures and mutation scratch are out of scope", () => {
  assert.equal(isProductionTs("tavern/connection-store.ts"), true);
  assert.equal(isProductionTs("tavern/connection-store.test.ts"), false);
  assert.equal(isProductionTs("tavern/loose.test-support.ts"), false);
  assert.equal(isProductionTs("test-fixtures/worker.ts"), false);
  assert.equal(isShipped("tools/live-run/core/capture.mjs"), true);
  assert.equal(isShipped("tools/live-run/core/capture.test.mjs"), false);
  assert.equal(isShipped("tools/lib/stardew-native-local-player-fixture.mjs"), true);
  assert.equal(isShipped("tools/fixtures/thing.mjs"), false);
  assert.equal(isShipped("tools/check-x.mutation.mjs"), false);
  assert.equal(isShipped("tools/start-farmhand-launcher.ps1"), true);
});

test("the repository's own tree derives two credential files and no violation", () => {
  const result = evaluate({ root: REPOSITORY_ROOT });
  assert.deepEqual(
    result.credentials.map((entry) => entry.leaf),
    ["auth.json", "tavern-connection-keys.json"],
  );
  assert.deepEqual(result.violations, []);
  assert.equal(result.checked.assemblers > 0, true);
  assert.equal(result.checked.filters > 0, true);
  assert.equal(result.checked.payloadWrites > 0, true);
});

/*
 * POPULATION 2: a written file whose PAYLOAD carries a live secret. Its authority is the write, not
 * a filename, so these cases drive the payload rule directly.
 */

/** A writer shaped like the Stardew composer: a Mod config carrying a bridge and a session token. */
const COMPOSER = `import { join } from "node:path";
const MOD_CONFIG_FILE = "config.json";
const HOST_PROFILE_ROOT = "player-host";
const MODS_DIRECTORY = "Mods";
const MOD_DIRECTORY = "GameBuddy";
export async function stage(facts: { transactionDirectory: string }) {
  const transactionDirectory = facts.transactionDirectory;
  const hostModDirectory = join(transactionDirectory, HOST_PROFILE_ROOT, MODS_DIRECTORY, MOD_DIRECTORY);
  const hostConfig = JSON.stringify({
    EnableLocalBridge: true,
    SessionToken: "live-session-secret",
  });
  await writeManagedFile(join(hostModDirectory, MOD_CONFIG_FILE), hostConfig);
}
`;

test("population 2 is derived from a written payload, and its destination resolves through the module's own joins", () => {
  const writes = credentialWrites(COMPOSER);
  assert.deepEqual(writes, [
    { destination: "<transactionDirectory>/player-host/Mods/GameBuddy/config.json", payload: "hostConfig" },
  ]);
  assert.deepEqual(destinationSuffixes(writes), [
    "GameBuddy/config.json",
    "Mods/GameBuddy/config.json",
    "player-host/Mods/GameBuddy/config.json",
  ]);
});

test("an $ENV reference is not a secret: the file holds the variable name, not the key", () => {
  const reference = `const entry = JSON.stringify({ apiKey: "$CPA_OAI_API_KEY" });\nawait writeFile(path, entry);\n`;
  assert.deepEqual(liveSecretFields(reference), []);
  assert.deepEqual(credentialWrites(reference), []);
});

test("the env-reference direction is the point: the same field with a live value IS a secret", () => {
  assert.deepEqual(
    liveSecretFields('const entry = JSON.stringify({ apiKey: "sk-live-key" });\n').map((field) => field.field),
    ["apiKey"],
  );
});

test("a module that holds a secret field but writes no file contributes no destination", () => {
  const fieldsOnly = `export type Command = Readonly<{ apiKey: string }>;\nexport const redact = (value: string): string => value;\n`;
  assert.deepEqual(credentialWrites(fieldsOnly), []);
});

test("a payload that is not a JSON.stringify constant is not read as a secret write", () => {
  const banner = `const note = "SessionToken: live-session-secret";\nawait writeFile(path, note);\n`;
  assert.deepEqual(credentialWrites(banner), []);
});

test("population 2 is derived from the real composer, and covers both staged profiles", () => {
  const writes = credentialPayloadPopulation(REPOSITORY_ROOT);
  assert.deepEqual(
    writes.map((write) => `${write.file}: ${write.destination}`),
    [
      "host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts: <transactionDirectory>/ai-client/Mods/GameBuddy/config.json",
      "host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts: <transactionDirectory>/player-host/Mods/GameBuddy/config.json",
    ],
  );
});

test("an assembler that names a population-2 destination is the violation, with its own code", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-credential-payload-"));
  try {
    const write = (relativePath, contents) => {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    };
    write("host/src/runtime-identity.ts", RUNTIME_IDENTITY);
    write("host/src/tavern/connection-store.ts", STORE);
    write("host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts", COMPOSER);
    write(
      "tools/diagnostic-bundle.mjs",
      `import { copyFile } from "node:fs/promises";\nimport { join } from "node:path";\nconst PROFILE_FILES = Object.freeze(["Mods/GameBuddy/config.json"]);\nexport async function bundle(attempt, out) {\n  for (const relative of PROFILE_FILES) await copyFile(join(attempt, relative), out);\n}\n`,
    );
    const { violations } = evaluate({ root });
    assert.deepEqual(
      violations.map((violation) => [violation.code, violation.file, violation.suffix]),
      [["assembler_names_credential_payload_file", "tools/diagnostic-bundle.mjs", "Mods/GameBuddy/config.json"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare config.json is NOT a population-2 violation, because four unrelated documents share the name", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-credential-payload-bare-"));
  try {
    const write = (relativePath, contents) => {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    };
    write("host/src/runtime-identity.ts", RUNTIME_IDENTITY);
    write("host/src/tavern/connection-store.ts", STORE);
    write("host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts", COMPOSER);
    write(
      "tools/unrelated-copy.mjs",
      `import { copyFile } from "node:fs/promises";\nimport { join } from "node:path";\nexport async function copy(root, out) {\n  await copyFile(join(root, "config.json"), out);\n}\n`,
    );
    assert.deepEqual(evaluate({ root }).violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a root that has the composer but derives no payload write fails instead of passing vacuously", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-credential-payload-vacuous-"));
  try {
    const write = (relativePath, contents) => {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    };
    write("host/src/runtime-identity.ts", RUNTIME_IDENTITY);
    write("host/src/tavern/connection-store.ts", STORE);
    write("host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts", "export const moved = 1;\n");
    assert.deepEqual(
      evaluate({ root }).violations.map((violation) => violation.code),
      ["credential_payload_population_empty"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI names the file and the credential path, and exits non-zero", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-credential-export-cli-"));
  try {
    const write = (relativePath, contents) => {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    };
    write("host/src/runtime-identity.ts", RUNTIME_IDENTITY);
    write("host/src/tavern/connection-store.ts", STORE);
    write(
      "tools/diagnostic-bundle.mjs",
      `import { copyFile } from "node:fs/promises";
export async function bundle(agentDir) {
  await copyFile(agentDir + "/auth.json", "out");
}
`,
    );
    const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /credential_export_isolation_failed violations=1/u);
    assert.match(
      result.stdout,
      /tools\/diagnostic-bundle\.mjs: assembles an artifact \(copyFile\) and names auth\.json as "\/auth\.json"/u,
    );
    assert.match(result.stdout, /an export may not carry it/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI prints the population it derived, so a green run says what it read", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-credential-export-green-"));
  try {
    for (const [relativePath, contents] of Object.entries(fixture({}))) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /credential_export_isolation_ok credentials=2 payload_writes=0 assemblers=0 filters=0 .*files=auth\.json,tavern-connection-keys\.json/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credentialPopulation reports drift separately from the population it derived", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-credential-export-population-"));
  try {
    for (const [relativePath, contents] of Object.entries(fixture({}))) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    const { credentials, drift } = credentialPopulation(root);
    assert.equal(credentials.length, 2);
    assert.deepEqual(drift, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
