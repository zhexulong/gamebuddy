/**
 * Tests for the Stardew live-run environment resolver.
 *
 * What these prove: the resolver reports READ facts differently from DERIVED
 * ones, it derives a missing registration through the product's own discovery
 * and admission path before publishing, and every unresolved case stops with one
 * specific code instead of a default. They run without a real Stardew install,
 * a real Steam registry, or a published Host generation: the seams under test are
 * the resolver's own leaf I/O, and the authorities are fakes.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  formatStardewLiveRunEnvironmentAssignmentLines,
  formatStardewLiveRunEnvironmentSummary,
  GAME_DIR_ENV,
  LIVE_RUN_ENVIRONMENT_SCHEMA,
  MOD_CONFIG_ENV,
  MODS_DIR_ENV,
  parseArguments,
  RUNTIME_ROOT_ENV,
  resolveStardewLiveRunEnvironment,
} from "./resolve-stardew-live-run-environment.mjs";

const RUNTIME_ROOT = "C:\\Users\\tester\\AppData\\Local\\GameBuddy";
const INSTALLATION = "D:\\Steam\\steamapps\\common\\Stardew Valley";
const HOST_ROOT = "C:\\repo\\host";
const OUTPUT_ROOT = "C:\\repo\\host\\dist";
const GENERATION = "g-local-1-2-abcdef";
const INVENTORY_DIGEST = "a".repeat(64);
const RUNTIME_ADMISSION_SHA256 = "b".repeat(64);

function missingError() {
  const error = new Error("ENOENT");
  error.code = "ENOENT";
  return error;
}

/** A fake file tree: no test touches the machine's real filesystem. */
function fakeFileSystem({ files = new Map(), directories = new Set(), digests = new Map() } = {}) {
  return Object.freeze({
    async kind(path) {
      if (directories.has(path)) return "directory";
      if (files.has(path)) return "file";
      return "missing";
    },
    async readText(path) {
      const value = files.get(path);
      if (value === undefined) throw missingError();
      return value;
    },
    async readDir(path) {
      if (!directories.has(path)) throw missingError();
      const prefix = path.endsWith("\\") ? path : `${path}\\`;
      const names = new Set();
      for (const key of [...files.keys(), ...directories]) {
        if (!key.startsWith(prefix) || key === path) continue;
        const name = key.slice(prefix.length).split("\\")[0];
        if (name !== undefined && name.length > 0) names.add(name);
      }
      return [...names].sort();
    },
    async sha256(path) {
      return digests.get(path) ?? "0".repeat(64);
    },
  });
}

function pointerText(overrides = {}) {
  return `${JSON.stringify({
    schema: "gamebuddy-host-production-current/v2",
    generation: GENERATION,
    inventoryDigest: INVENTORY_DIGEST,
    runtimeAdmissionSha256: RUNTIME_ADMISSION_SHA256,
    ...overrides,
  })}\n`;
}

/** A consistent output root: pointer, generation directory, inventory and admission. */
function generationTree({ generation = GENERATION, overrides = {} } = {}) {
  const artifactRoot = resolve(OUTPUT_ROOT, "generations", generation);
  return {
    artifactRoot,
    directories: new Set([OUTPUT_ROOT, resolve(OUTPUT_ROOT, "generations"), artifactRoot]),
    files: new Map([
      [resolve(OUTPUT_ROOT, "current.json"), pointerText(overrides)],
      [
        resolve(artifactRoot, "production-inventory.json"),
        `${JSON.stringify({ digest: INVENTORY_DIGEST, entries: [{ path: "main.js" }] })}\n`,
      ],
      [resolve(artifactRoot, "host-runtime-admission.json"), "{}\n"],
    ]),
    digests: new Map([[resolve(artifactRoot, "host-runtime-admission.json"), RUNTIME_ADMISSION_SHA256]]),
  };
}

const GENERATION_FACTS = Object.freeze({
  outputRootSource: "test",
  outputRoot: OUTPUT_ROOT,
  pointerPath: resolve(OUTPUT_ROOT, "current.json"),
  generation: GENERATION,
  inventoryDigest: INVENTORY_DIGEST,
  runtimeAdmissionSha256: RUNTIME_ADMISSION_SHA256,
  artifactRoot: resolve(OUTPUT_ROOT, "generations", GENERATION),
  inventoryEntryCount: 1,
  availableGenerations: 1,
  shadowedDefaultOutputRoot: null,
});

const FIXTURE_ROOTS = Object.freeze({
  profileRoot: "C:\\Users\\tester\\AppData\\Local\\GameBuddy",
  fixturesRoot: "C:\\Users\\tester\\AppData\\Local\\GameBuddy\\stardew-fixtures",
  profilesDir: "C:\\Users\\tester\\AppData\\Local\\GameBuddy\\stardew-profiles",
  profileRootOverridden: false,
  fixturesRootOverridden: false,
});

function readyRegistration(overrides = {}) {
  return {
    schema: "gamebuddy-stardew-installation-registration/v1",
    binding: { rootLayoutVersion: 1 },
    revision: 10,
    state: "ready",
    locator: INSTALLATION,
    activeAttempt: null,
    ...overrides,
  };
}

/** The fake product authorities, recording what the resolver asked them to do. */
function fakeAuthorities({
  registration = null,
  candidates = [],
  diagnostics = [],
  digest = "c".repeat(64),
  manifestError = null,
} = {}) {
  const record = {
    admitted: [],
    published: [],
    discovered: 0,
    providerCreated: 0,
    manifestLoaded: 0,
  };
  return {
    record,
    authorities: Object.freeze({
      readRegistration: async () => registration,
      publishRegistration: async (runtimeRoot, expectedRevision, candidate) => {
        record.published.push({ runtimeRoot, expectedRevision, candidate: { ...candidate } });
        return { ...candidate, digest };
      },
      admitInstallation: async (locator) => {
        record.admitted.push(locator);
      },
      createDiscoveryProvider: () => {
        record.providerCreated += 1;
        return {
          discover: async () => {
            record.discovered += 1;
            return { candidates, diagnostics };
          },
          confirm: (candidateId) => {
            const found = candidates.find((candidate) => candidate.candidateId === candidateId);
            if (found === undefined) throw new Error("candidate-invalid");
            return found.root;
          },
        };
      },
      loadDeploymentManifest: async () => {
        record.manifestLoaded += 1;
        if (manifestError !== null) throw manifestError;
        return {
          runtimeRoot: RUNTIME_ROOT,
          topology: "independent_chat_and_game_surfaces",
          principal: { continuityId: "c", companionId: "n", playerId: "p" },
          authorityGeneration: 1,
        };
      },
    }),
  };
}

function baseOptions({
  registration = null,
  candidates = [],
  diagnostics = [],
  env = {},
  directories,
  files,
  digests,
  manifestError = null,
  runtimeRootPresent = true,
} = {}) {
  const tree = generationTree();
  const { record, authorities } = fakeAuthorities({ registration, candidates, diagnostics, manifestError });
  const fileSystem = fakeFileSystem({
    files: files ?? tree.files,
    directories: new Set([...(directories ?? tree.directories), ...(runtimeRootPresent ? [RUNTIME_ROOT] : [])]),
    digests: digests ?? tree.digests,
  });
  return {
    record,
    options: {
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", ...env },
      repositoryRoot: "C:\\repo",
      hostRoot: HOST_ROOT,
      hostGenerationOutputRoot: OUTPUT_ROOT,
      overrides: {
        platform: "win32",
        fileSystem,
        resolveFixtureRoots: () => FIXTURE_ROOTS,
        readHostGeneration: async () => GENERATION_FACTS,
        openHostAuthorities: async () => authorities,
        now: () => "2026-01-01T00:00:00.000Z",
      },
    },
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, code, `expected ${code}, got ${error.message}`);
    return true;
  });
}

test("a ready registration is READ: the recorded locator is adopted and re-admitted, and nothing is published", async () => {
  const { record, options } = baseOptions({ registration: readyRegistration() });
  const facts = await resolveStardewLiveRunEnvironment(options);

  assert.equal(facts.schema, LIVE_RUN_ENVIRONMENT_SCHEMA);
  assert.equal(facts.installation.provenance, "read");
  assert.equal(facts.installation.origin, "registration");
  assert.equal(facts.installation.locator, INSTALLATION);
  assert.equal(facts.installation.admitted, true);
  assert.equal(facts.installation.registrationRevision, 10);
  assert.deepEqual(record.admitted, [INSTALLATION]);
  assert.equal(record.published.length, 0);
  assert.equal(record.discovered, 0);
  assert.ok(facts.readFacts.includes("installation.locator"));
  assert.equal(facts.derivedFacts.includes("installation.locator"), false);
  assert.equal(facts.environment.values.find((entry) => entry.name === GAME_DIR_ENV).provenance, "read");
});

test("a ready registration that records an attempt is still adopted: the attempt is reported, not fatal", async () => {
  const { options } = baseOptions({
    registration: readyRegistration({ activeAttempt: { bootstrapCorrelation: "attempt-1" } }),
  });
  const facts = await resolveStardewLiveRunEnvironment(options);

  assert.equal(facts.installation.locator, INSTALLATION);
  assert.equal(facts.installation.registrationActiveAttempt, "attempt-1");
  assert.match(facts.notes.join("\n"), /bootstrap attempt/);
});

test("no registration DERIVES the installation through discovery, admission and publication", async () => {
  const candidates = [{ candidateId: "opaque-1", source: "steam-registry", root: INSTALLATION }];
  const { record, options } = baseOptions({ registration: null, candidates });
  const facts = await resolveStardewLiveRunEnvironment(options);

  assert.equal(facts.installation.provenance, "derived");
  assert.equal(facts.installation.origin, "discovery");
  assert.equal(facts.installation.locator, INSTALLATION);
  assert.equal(record.discovered, 1);
  assert.deepEqual(record.admitted, [INSTALLATION]);
  assert.equal(record.published.length, 1);
  assert.equal(record.published[0].runtimeRoot, RUNTIME_ROOT);
  assert.equal(record.published[0].expectedRevision, null);
  assert.deepEqual(record.published[0].candidate, {
    schema: "gamebuddy-stardew-installation-registration/v1",
    binding: { rootLayoutVersion: 1 },
    revision: 1,
    state: "ready",
    locator: INSTALLATION,
    activeAttempt: null,
  });
  assert.equal(facts.installation.registrationRevision, 1);
  assert.equal(facts.installation.previousRegistrationState, "absent");
  assert.ok(facts.derivedFacts.includes("installation.locator"));
  assert.equal(facts.readFacts.includes("installation.locator"), false);
  assert.equal(facts.environment.values.find((entry) => entry.name === GAME_DIR_ENV).provenance, "derived");
});

test("an invalid registration is replaced from the next revision", async () => {
  const candidates = [{ candidateId: "opaque-1", source: "steam-vdf", root: INSTALLATION }];
  const { record, options } = baseOptions({
    registration: readyRegistration({ state: "invalid", locator: null, revision: 4 }),
    candidates,
  });
  const facts = await resolveStardewLiveRunEnvironment(options);

  assert.equal(facts.installation.provenance, "derived");
  assert.equal(record.published[0].expectedRevision, 4);
  assert.equal(record.published[0].candidate.revision, 5);
  assert.equal(facts.installation.previousRegistrationState, "invalid");
});

test("no discovery candidate stops the run and publishes nothing", async () => {
  const { record, options } = baseOptions({ diagnostics: ["registry-unavailable", "source-unavailable"] });
  await rejectsWithCode(resolveStardewLiveRunEnvironment(options), "stardew_live_run_installation_candidates_none");
  assert.equal(record.published.length, 0);
  assert.deepEqual(record.admitted, []);
});

test("several candidates stop the run rather than guessing; an explicit --game-dir resolves it", async () => {
  const candidates = [
    { candidateId: "opaque-1", source: "steam-registry", root: "D:\\steam\\steamapps\\common\\Stardew Valley" },
    { candidateId: "opaque-2", source: "steam-vdf", root: "E:\\SteamLibrary\\steamapps\\common\\Stardew Valley" },
  ];
  const { record, options } = baseOptions({ candidates });
  await rejectsWithCode(
    resolveStardewLiveRunEnvironment(options),
    "stardew_live_run_installation_candidates_ambiguous",
  );
  assert.equal(record.published.length, 0);

  const explicit = baseOptions({ candidates });
  const facts = await resolveStardewLiveRunEnvironment({
    ...explicit.options,
    gameDirectory: "E:/SteamLibrary/steamapps/common/Stardew Valley",
  });
  assert.equal(facts.installation.locator, "E:\\SteamLibrary\\steamapps\\common\\Stardew Valley");
  assert.equal(facts.installation.provenance, "operator");
  assert.equal(explicit.record.published[0].candidate.locator, "E:\\SteamLibrary\\steamapps\\common\\Stardew Valley");
});

test("an explicit --game-dir that contradicts an unambiguous discovery result is refused", async () => {
  const candidates = [{ candidateId: "opaque-1", source: "steam-registry", root: INSTALLATION }];
  const { record, options } = baseOptions({ candidates });
  await rejectsWithCode(
    resolveStardewLiveRunEnvironment({ ...options, gameDirectory: "E:\\Other\\Stardew Valley" }),
    "stardew_live_run_game_directory_conflicts_with_discovery",
  );
  assert.equal(record.published.length, 0);
});

test("an explicit --game-dir that contradicts the registration is refused, and nothing is published", async () => {
  const { record, options } = baseOptions({ registration: readyRegistration() });
  await rejectsWithCode(
    resolveStardewLiveRunEnvironment({ ...options, gameDirectory: "E:\\Other\\Stardew Valley" }),
    "stardew_live_run_game_directory_conflicts_with_registration",
  );
  assert.equal(record.published.length, 0);
  assert.deepEqual(record.admitted, []);
});

test("a registered installation that no longer admits is refused with the locator named", async () => {
  const { authorities } = fakeAuthorities({ registration: readyRegistration() });
  const { options } = baseOptions({ registration: readyRegistration() });
  const failing = {
    ...authorities,
    admitInstallation: async () => {
      throw new Error("stardew_installation_admission_failed");
    },
  };
  await assert.rejects(
    resolveStardewLiveRunEnvironment({
      ...options,
      overrides: { ...options.overrides, openHostAuthorities: async () => failing },
    }),
    (error) => {
      assert.equal(error.message, "stardew_live_run_registered_installation_not_admissible");
      assert.equal(error.detail.registeredInstallation, INSTALLATION);
      assert.equal(error.detail.reason, "stardew_installation_admission_failed");
      return true;
    },
  );
});

test("a pre-set GAMEBUDDY_STARDEW_GAME_DIR that disagrees with the registration is a conflict", async () => {
  const { options } = baseOptions({
    registration: readyRegistration(),
    env: { [GAME_DIR_ENV]: "D:/steam/steamapps/common/Stardew Valley" },
  });
  const facts = await resolveStardewLiveRunEnvironment(options);
  assert.equal(facts.installation.locator, INSTALLATION);

  const conflicting = baseOptions({
    registration: readyRegistration(),
    env: { [GAME_DIR_ENV]: "E:/Other/Stardew Valley" },
  });
  await rejectsWithCode(resolveStardewLiveRunEnvironment(conflicting.options), "stardew_live_run_environment_conflict");
});

test("the derived environment carries the Mods directory, the Mod config path and the fixture roots", async () => {
  const { options } = baseOptions({ registration: readyRegistration() });
  const facts = await resolveStardewLiveRunEnvironment(options);
  const value = (name) => facts.environment.values.find((entry) => entry.name === name).value;

  assert.equal(value(GAME_DIR_ENV), INSTALLATION);
  assert.equal(value(MODS_DIR_ENV), `${INSTALLATION}\\Mods`);
  assert.equal(value(MOD_CONFIG_ENV), `${INSTALLATION}\\Mods\\GameBuddy.Stardew\\config.json`);
  assert.equal(value(RUNTIME_ROOT_ENV), RUNTIME_ROOT);
  assert.equal(value("GAMEBUDDY_STARDEW_FIXTURE_ROOT"), FIXTURE_ROOTS.fixturesRoot);
});

test("credentials are reported as references only: the value never appears in the output", async () => {
  const secret = "sk-live-run-secret-value";
  const { options } = baseOptions({ registration: readyRegistration(), env: { CPA_OAI_API_KEY: secret } });
  const facts = await resolveStardewLiveRunEnvironment(options);

  const credential = facts.credentialReferences.find((entry) => entry.name === "CPA_OAI_API_KEY");
  assert.equal(credential.present, true);
  assert.equal(credential.required, true);
  assert.equal(credential.valueDisclosure, "never_read");
  assert.equal(JSON.stringify(facts).includes(secret), false);
  assert.equal(formatStardewLiveRunEnvironmentAssignmentLines(facts).includes(secret), false);
  assert.equal(formatStardewLiveRunEnvironmentSummary(facts).includes(secret), false);
});

test("the summary separates READ facts from DERIVED facts", async () => {
  const candidates = [{ candidateId: "opaque-1", source: "steam-registry", root: INSTALLATION }];
  const derived = await resolveStardewLiveRunEnvironment(baseOptions({ candidates }).options);
  const derivedSummary = formatStardewLiveRunEnvironmentSummary(derived);
  assert.match(derivedSummary, /read=\{[^}]*hostGeneration\.generation/);
  assert.match(derivedSummary, /derived=\{[^}]*installation\.locator/);
  assert.match(derivedSummary, /installation=.* \(derived: discovery\)/);

  const read = await resolveStardewLiveRunEnvironment(baseOptions({ registration: readyRegistration() }).options);
  const readSummary = formatStardewLiveRunEnvironmentSummary(read);
  assert.match(readSummary, /read=\{[^}]*installation\.locator/);
  assert.match(readSummary, /installation=.* \(read: registration\)/);
});

test("the pointer selects the generation and its recorded digests are checked against that generation", async () => {
  const tree = generationTree();
  const { record, options } = baseOptions({
    registration: readyRegistration(),
    files: tree.files,
    directories: tree.directories,
    digests: tree.digests,
  });
  const facts = await resolveStardewLiveRunEnvironment({
    ...options,
    overrides: { ...options.overrides, readHostGeneration: undefined },
  });

  assert.equal(facts.hostGeneration.generation, GENERATION);
  assert.equal(facts.hostGeneration.inventoryDigest, INVENTORY_DIGEST);
  assert.equal(facts.hostGeneration.runtimeAdmissionSha256, RUNTIME_ADMISSION_SHA256);
  assert.equal(facts.hostGeneration.inventoryEntryCount, 1);
  assert.equal(record.published.length, 0);
});

test("a locally built root without a pointer is refused: several generations is ambiguous, none is missing", async () => {
  const ambiguousRoot = "C:\\local\\dist";
  const ambiguous = baseOptions({
    registration: readyRegistration(),
    directories: new Set([
      RUNTIME_ROOT,
      ambiguousRoot,
      resolve(ambiguousRoot, "generations"),
      resolve(ambiguousRoot, "generations", "g-one"),
      resolve(ambiguousRoot, "generations", "g-two"),
    ]),
    files: new Map(),
  });
  await rejectsWithCode(
    resolveStardewLiveRunEnvironment({
      ...ambiguous.options,
      hostGenerationOutputRoot: ambiguousRoot,
      overrides: { ...ambiguous.options.overrides, readHostGeneration: undefined },
    }),
    "stardew_live_run_host_generation_ambiguous",
  );

  const emptyRoot = "C:\\empty\\dist";
  const empty = baseOptions({
    registration: readyRegistration(),
    directories: new Set([RUNTIME_ROOT, emptyRoot]),
    files: new Map(),
  });
  await assert.rejects(
    resolveStardewLiveRunEnvironment({
      ...empty.options,
      hostGenerationOutputRoot: emptyRoot,
      overrides: { ...empty.options.overrides, readHostGeneration: undefined },
    }),
    (error) => {
      assert.equal(error.message, "stardew_live_run_host_generation_pointer_missing");
      assert.match(error.detail.hint, /GAMEBUDDY_HOST_PRODUCTION_ROOT/);
      return true;
    },
  );
});

test("a pointer whose digests disagree with the generation it names is refused", async () => {
  const tree = generationTree();
  const digestMismatch = baseOptions({
    registration: readyRegistration(),
    files: new Map([
      ...tree.files,
      [resolve(OUTPUT_ROOT, "current.json"), pointerText({ inventoryDigest: "d".repeat(64) })],
    ]),
    directories: tree.directories,
    digests: tree.digests,
  });
  await rejectsWithCode(
    resolveStardewLiveRunEnvironment({
      ...digestMismatch.options,
      overrides: { ...digestMismatch.options.overrides, readHostGeneration: undefined },
    }),
    "stardew_live_run_host_generation_digest_mismatch",
  );

  const admissionMismatch = baseOptions({
    registration: readyRegistration(),
    files: tree.files,
    directories: tree.directories,
    digests: new Map([[resolve(tree.artifactRoot, "host-runtime-admission.json"), "e".repeat(64)]]),
  });
  await rejectsWithCode(
    resolveStardewLiveRunEnvironment({
      ...admissionMismatch.options,
      overrides: { ...admissionMismatch.options.overrides, readHostGeneration: undefined },
    }),
    "stardew_live_run_host_generation_runtime_admission_mismatch",
  );
});

test("a pointer naming a generation that is not on disk is refused, and so is a malformed pointer", async () => {
  const tree = generationTree();
  const unresolved = baseOptions({
    registration: readyRegistration(),
    files: new Map([...tree.files, [resolve(OUTPUT_ROOT, "current.json"), pointerText({ generation: "g-not-built" })]]),
    directories: tree.directories,
    digests: tree.digests,
  });
  await rejectsWithCode(
    resolveStardewLiveRunEnvironment({
      ...unresolved.options,
      overrides: { ...unresolved.options.overrides, readHostGeneration: undefined },
    }),
    "stardew_live_run_host_generation_unresolved",
  );

  const malformed = baseOptions({
    registration: readyRegistration(),
    files: new Map([...tree.files, [resolve(OUTPUT_ROOT, "current.json"), "{ nope"]]),
    directories: tree.directories,
    digests: tree.digests,
  });
  await rejectsWithCode(
    resolveStardewLiveRunEnvironment({
      ...malformed.options,
      overrides: { ...malformed.options.overrides, readHostGeneration: undefined },
    }),
    "stardew_live_run_host_generation_pointer_invalid",
  );
});

test("the runtime root must exist and must agree with the deployment manifest", async () => {
  const missingRoot = baseOptions({
    registration: readyRegistration(),
    runtimeRootPresent: false,
  });
  await rejectsWithCode(resolveStardewLiveRunEnvironment(missingRoot.options), "stardew_live_run_runtime_root_missing");

  const manifest = baseOptions({ registration: readyRegistration() });
  const manifestPath = resolve(RUNTIME_ROOT, "manifest.json");
  const withManifest = {
    ...manifest.options,
    overrides: {
      ...manifest.options.overrides,
      fileSystem: fakeFileSystem({
        files: new Map([...generationTree().files, [manifestPath, "{}\n"]]),
        directories: new Set([...generationTree().directories, RUNTIME_ROOT]),
        digests: generationTree().digests,
      }),
    },
  };
  const facts = await resolveStardewLiveRunEnvironment(withManifest);
  assert.equal(facts.deploymentManifest.present, true);
  assert.equal(facts.deploymentManifest.runtimeRoot, RUNTIME_ROOT);
});

test("a runtime root override that is relative, or absent LOCALAPPDATA, is unresolved", async () => {
  const relative = baseOptions({ registration: readyRegistration(), env: { [RUNTIME_ROOT_ENV]: "relative\\root" } });
  await rejectsWithCode(resolveStardewLiveRunEnvironment(relative.options), "stardew_live_run_runtime_root_unresolved");

  const { options } = baseOptions({ registration: readyRegistration() });
  const noLocalAppData = { ...options, env: {} };
  await rejectsWithCode(resolveStardewLiveRunEnvironment(noLocalAppData), "stardew_live_run_runtime_root_unresolved");
});

test("unreadable registration storage is refused rather than treated as an absent registration", async () => {
  const { authorities } = fakeAuthorities({ registration: null });
  const failing = {
    ...authorities,
    readRegistration: async () => {
      throw new Error("stardew_installation_registration_unavailable");
    },
  };
  const { options } = baseOptions({ registration: null });
  await assert.rejects(
    resolveStardewLiveRunEnvironment({
      ...options,
      overrides: { ...options.overrides, openHostAuthorities: async () => failing },
    }),
    (error) => {
      assert.equal(error.message, "stardew_live_run_registration_unreadable");
      assert.equal(error.detail.reason, "stardew_installation_registration_unavailable");
      return true;
    },
  );
});

test("a publish that the registration authority refuses is reported as a publish failure", async () => {
  const candidates = [{ candidateId: "opaque-1", source: "steam-registry", root: INSTALLATION }];
  const { authorities } = fakeAuthorities({ candidates });
  const failing = {
    ...authorities,
    publishRegistration: async () => {
      throw new Error("stardew_installation_registration_busy");
    },
  };
  const { options } = baseOptions({ candidates });
  await assert.rejects(
    resolveStardewLiveRunEnvironment({
      ...options,
      overrides: { ...options.overrides, openHostAuthorities: async () => failing },
    }),
    (error) => {
      assert.equal(error.message, "stardew_live_run_registration_publish_failed");
      assert.equal(error.detail.reason, "stardew_installation_registration_busy");
      return true;
    },
  );
});

test("a non-Windows machine is refused before any authority is consulted", async () => {
  const { record, options } = baseOptions({ registration: readyRegistration() });
  await rejectsWithCode(
    resolveStardewLiveRunEnvironment({ ...options, overrides: { ...options.overrides, platform: "linux" } }),
    "stardew_live_run_environment_requires_windows",
  );
  assert.equal(record.providerCreated, 0);
});

test("arguments are parsed without inventing a value for what was not given", () => {
  assert.deepEqual(parseArguments([]), {
    printEnvironment: false,
    runtimeRoot: null,
    hostGenerationOutputRoot: null,
    gameDirectory: null,
    ladder: null,
  });
  assert.deepEqual(parseArguments(["--print-env", "--game-dir", INSTALLATION, "--ladder", "6"]), {
    printEnvironment: true,
    runtimeRoot: null,
    hostGenerationOutputRoot: null,
    gameDirectory: INSTALLATION,
    ladder: "6",
  });
});

test("the assignment lines carry the derived environment and the ladder when one was given", async () => {
  const { options } = baseOptions({ registration: readyRegistration() });
  const facts = await resolveStardewLiveRunEnvironment({ ...options, ladder: "6" });
  const lines = formatStardewLiveRunEnvironmentAssignmentLines(facts).split("\n");

  assert.ok(lines.includes(`${GAME_DIR_ENV}=${INSTALLATION}`));
  assert.ok(lines.includes(`GAMEBUDDY_AGENT_LADDER=6`));
  assert.equal(
    facts.environment.values.find((entry) => entry.name === "GAMEBUDDY_AGENT_LADDER").provenance,
    "operator",
  );
});

test("a run that would select the generation through host/dist is warned about the Host's own re-attestation", async () => {
  const tree = generationTree();
  const { options } = baseOptions({
    registration: readyRegistration(),
    files: tree.files,
    directories: tree.directories,
    digests: tree.digests,
  });
  const facts = await resolveStardewLiveRunEnvironment({
    ...options,
    hostGenerationOutputRoot: null,
    overrides: { ...options.overrides, readHostGeneration: undefined },
  });

  assert.equal(facts.hostGeneration.outputRootSource, "host/dist");
  assert.ok(facts.warnings.some((warning) => warning.includes("GAMEBUDDY_HOST_PRODUCTION_ROOT")));
  assert.match(formatStardewLiveRunEnvironmentSummary(facts), /WARNING .*GAMEBUDDY_HOST_PRODUCTION_ROOT/);

  const configured = await resolveStardewLiveRunEnvironment({
    ...options,
    overrides: { ...options.overrides, readHostGeneration: undefined },
  });
  assert.equal(configured.hostGeneration.outputRootSource, "GAMEBUDDY_HOST_PRODUCTION_ROOT");
  assert.equal(
    configured.warnings.some((warning) => warning.includes("GAMEBUDDY_HOST_PRODUCTION_ROOT")),
    false,
  );
});

test("a missing deployed Mod directory is reported as a run-owned step, not as a resolution failure", async () => {
  const { options } = baseOptions({ registration: readyRegistration() });
  const facts = await resolveStardewLiveRunEnvironment(options);

  assert.equal(facts.environment.modDirectoryPresent, false);
  assert.ok(facts.warnings.some((warning) => warning.includes("fixture transaction")));
});
