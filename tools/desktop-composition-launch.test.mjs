import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  admitDesktopCompositionGeneration,
  assertDesktopCompositionRunRoots,
  composeDesktopBootstrapFrame,
  composeDesktopChildEnvironment,
  createDesktopCompositionRootLayout,
  desktopCompositionMutableRootPaths,
  installDesktopCompositionGeneration,
  launchDesktopCompositionGateChild,
  measureDesktopCompositionRunRoots,
  readDesktopCompositionRuntimeRoot,
  readProductionPointer,
  validateBootstrapAcknowledgement,
  validateCompositionNonceDigest,
  validateCompositionReadyMessage,
  validateCompositionSurface,
  validateGuardianHelloRequest,
} from "./desktop-composition-launch.mjs";

/**
 * The acknowledgement's key sequence, read from the declaration the writer is written beside.
 *
 * Reading it instead of restating it is the point: this test used to build a nine-key ack of its own and
 * assert the launcher accepted it, so when the Host's writer gained `drainDeadlineMs` and
 * `stepHangDeadlineMs` both stayed green and every composed launch failed. The Host's wire test pins the
 * real acknowledgement to this same file, so a field added on one side now fails a test on the other.
 */
const declaredAckKeys = JSON.parse(
  readFileSync(new URL("../host/src/bootstrap/wire/desktop-host-bootstrap-ack.keys.json", import.meta.url), "utf8"),
);

/**
 * The acknowledgement a Host answers with, built key by key from the declaration above.
 *
 * Both places in this file that need an ack - the validator case and the cooperative stub child the spawn
 * test launches - use this, so no third copy of the wire shape can appear here and stay green after the
 * writer moves.
 */
function acknowledgementFrom(frame, { drainDeadlineMs = 60_000, stepHangDeadlineMs = 10_000 } = {}) {
  const values = {
    schema: "gamebuddy-desktop-host-bootstrap/v1",
    protocolVersion: 1,
    status: "accepted",
    bootstrapId: frame.bootstrapId,
    generation: frame.generation,
    inventoryDigest: frame.inventoryDigest,
    runtimeAdmissionSha256: frame.runtimeAdmissionSha256,
    rootLayoutSchema: frame.rootLayout.schema,
    drainDeadlineMs,
    stepHangDeadlineMs,
    sessionEntry: {
      kind: "http",
      method: "POST",
      route: "/api/composed-reference-game/v1/bootstrap",
      bodyKeys: ["apiVersion", "bootstrapToken"],
    },
  };
  const ack = {};
  for (const key of declaredAckKeys) {
    assert.ok(
      Object.hasOwn(values, key),
      `the writer declares acknowledgement key '${key}' this helper has no value for`,
    );
    ack[key] = values[key];
  }
  return ack;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hex = "a".repeat(64);

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-compose-launch-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

test("composition launch admits only the three composed surfaces and the hex marker digest", () => {
  for (const surface of ["composed-reference-game", "chat-only", "management"]) {
    assert.equal(validateCompositionSurface(surface), true, surface);
  }
  assert.equal(validateCompositionSurface(undefined), true);
  for (const surface of ["", "chat", "bogus", "chat-live"]) {
    assert.equal(validateCompositionSurface(surface), false, surface);
  }
  assert.equal(validateCompositionNonceDigest(undefined), true);
  assert.equal(validateCompositionNonceDigest(hex), true);
  assert.equal(validateCompositionNonceDigest(hex.slice(1)), false);
  assert.equal(validateCompositionNonceDigest("not-hex"), false);
});

test("composition launch derives the exact launcher-shaped root layout from the child LOCALAPPDATA", () => {
  const layout = createDesktopCompositionRootLayout("C:\\fresh", "g-1-2-3");
  assert.equal(layout.programRoot, "C:\\fresh\\Programs\\GameBuddy");
  assert.equal(layout.dataRoot, "C:\\fresh\\GameBuddy\\data");
  assert.equal(layout.operationalRoot, "C:\\fresh\\GameBuddy\\operational");
  assert.equal(layout.presentationRoot, "C:\\fresh\\GameBuddy\\presentation");
  assert.equal(layout.generationRoot, "C:\\fresh\\Programs\\GameBuddy\\g-1-2-3");
  assert.equal(layout.moduleDirectory, "C:\\fresh\\Programs\\GameBuddy\\g-1-2-3\\bootstrap\\entry");
  assert.throws(() => createDesktopCompositionRootLayout("", "g-1"), /desktop_compose_root_invalid/);
  assert.throws(
    () => createDesktopCompositionRootLayout("C:\\fresh", "bad generation"),
    /desktop_compose_generation_invalid/,
  );
});

test("the run-root measurement fails closed when the child wrote outside the declared layout", async () => {
  // Today's measured shape: the manifest's runtimeRoot is the temp root itself, so the child's
  // mutable roots land directly under it while the declared GameBuddy\{data,operational,presentation}
  // stay empty. The three-directory check reported that run as "the temp root is empty".
  await withRoot(async (root) => {
    await mkdir(join(root, "GameBuddy", "data"), { recursive: true });
    await mkdir(join(root, "GameBuddy", "operational"), { recursive: true });
    await mkdir(join(root, "GameBuddy", "presentation"), { recursive: true });
    await mkdir(join(root, "Programs", "GameBuddy", "g-1"), { recursive: true });
    await writeFile(join(root, "Programs", "GameBuddy", "g-1", "runtime.js"), "x");
    await mkdir(join(root, "contexts", "c1"), { recursive: true });
    await writeFile(join(root, "contexts", "c1", "session.jsonl"), "{}\n");
    const manifestPath = join(root, "deployment-manifest.json");
    await writeFile(manifestPath, JSON.stringify({ runtimeRoot: root }));

    const measurement = await measureDesktopCompositionRunRoots({
      root,
      runtimeRoot: await readDesktopCompositionRuntimeRoot({ manifestPath }),
    });
    assert.equal(measurement.declaredFileCount, 0, "the declared mutable roots stay empty");
    // The manifest and the session write; the launcher's own installed generation under Programs is
    // never counted (it would make this three).
    assert.equal(measurement.resolved.fileCount, 2);
    assert.throws(
      () => assertDesktopCompositionRunRoots(measurement),
      /desktop_compose_run_roots_declared_layout_unused/,
    );
  });
});

test("the run-root measurement passes a run whose manifest runtimeRoot is the declared data root", async () => {
  await withRoot(async (root) => {
    const dataRoot = join(root, "GameBuddy", "data");
    await mkdir(join(dataRoot, "tavern"), { recursive: true });
    await writeFile(join(dataRoot, "tavern", "tavern.sqlite"), "db");
    await mkdir(join(root, "Programs", "GameBuddy", "g-1"), { recursive: true });
    await writeFile(join(root, "Programs", "GameBuddy", "g-1", "runtime.js"), "x");
    const manifestPath = join(root, "deployment-manifest.json");
    await writeFile(manifestPath, JSON.stringify({ runtimeRoot: dataRoot }));

    const measurement = await measureDesktopCompositionRunRoots({
      root,
      runtimeRoot: await readDesktopCompositionRuntimeRoot({ manifestPath }),
    });
    assert.equal(measurement.declaredFileCount, 1);
    assert.equal(measurement.resolved.path, resolve(dataRoot));
    assert.equal(measurement.resolved.fileCount, 1);
    assert.equal(assertDesktopCompositionRunRoots(measurement), measurement);
  });
});

test("the run-root measurement passes before a run has written anything", async () => {
  await withRoot(async (root) => {
    const measurement = await measureDesktopCompositionRunRoots({ root, runtimeRoot: root });
    assert.equal(measurement.declaredFileCount, 0);
    assert.equal(measurement.resolved.fileCount, 0);
    assert.equal(assertDesktopCompositionRunRoots(measurement), measurement);
  });
});

test("the mutable root paths and the runtime root reader reject malformed inputs", async () => {
  assert.deepEqual(desktopCompositionMutableRootPaths("C:\\fresh"), {
    data: "C:\\fresh\\GameBuddy\\data",
    operational: "C:\\fresh\\GameBuddy\\operational",
    presentation: "C:\\fresh\\GameBuddy\\presentation",
  });
  assert.throws(() => desktopCompositionMutableRootPaths(""), /desktop_compose_root_invalid/);
  assert.throws(() => assertDesktopCompositionRunRoots(null), /desktop_compose_run_roots_invalid/);
  await withRoot(async (root) => {
    const manifestPath = join(root, "deployment-manifest.json");
    await assert.rejects(
      () => readDesktopCompositionRuntimeRoot({ manifestPath }),
      /desktop_compose_manifest_unreadable/,
    );
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2 }));
    await assert.rejects(
      () => readDesktopCompositionRuntimeRoot({ manifestPath }),
      /desktop_compose_manifest_runtime_root_invalid/,
    );
    await assert.rejects(
      () => readDesktopCompositionRuntimeRoot({ manifestPath: "" }),
      /desktop_compose_manifest_invalid/,
    );
  });
});

test("composition launch composes the exact schema-v2 bootstrap frame", () => {
  const layout = createDesktopCompositionRootLayout("C:\\fresh", "g-1");
  const frame = composeDesktopBootstrapFrame({
    bootstrapId: hex,
    generation: "g-1",
    inventoryDigest: hex,
    runtimeAdmissionSha256: hex,
    rootLayout: layout,
  });
  assert.deepEqual(frame, {
    schema: "gamebuddy-desktop-host-bootstrap/v1",
    protocolVersion: 1,
    bootstrapId: hex,
    generation: "g-1",
    inventoryDigest: hex,
    runtimeAdmissionSha256: hex,
    rootLayout: {
      schema: "gamebuddy-windows-root-layout/v1",
      programRoot: "C:\\fresh\\Programs\\GameBuddy",
      dataRoot: "C:\\fresh\\GameBuddy\\data",
      operationalRoot: "C:\\fresh\\GameBuddy\\operational",
      presentationRoot: "C:\\fresh\\GameBuddy\\presentation",
    },
  });
  assert.throws(
    () =>
      composeDesktopBootstrapFrame({
        bootstrapId: "x",
        generation: "g-1",
        inventoryDigest: hex,
        runtimeAdmissionSha256: hex,
        rootLayout: layout,
      }),
    /desktop_compose_frame_invalid/,
  );
});

test("composition launch validates the bootstrap acknowledgement and guardian hello with exact binding facts", () => {
  const expected = { bootstrapId: hex, generation: "g-1", inventoryDigest: hex, runtimeAdmissionSha256: hex };
  const ack = acknowledgementFrom({
    ...expected,
    rootLayout: { schema: "gamebuddy-windows-root-layout/v1" },
  });
  assert.deepEqual(Object.keys(ack), declaredAckKeys);
  assert.equal(validateBootstrapAcknowledgement(ack, expected), true);
  // The nine-key frame this launcher used to require no longer is the acknowledgement: a Host that predates
  // the two deadline fields must not pass as the current one.
  const { drainDeadlineMs: _drain, stepHangDeadlineMs: _hang, ...staleNineKey } = ack;
  assert.equal(validateBootstrapAcknowledgement(staleNineKey, expected), false);
  assert.equal(
    validateBootstrapAcknowledgement(
      { ...ack, sessionEntry: { kind: "browser", launchPath: "/", bootFragmentKey: "boot" } },
      expected,
    ),
    true,
  );
  assert.equal(validateBootstrapAcknowledgement({ ...ack, sessionEntry: { kind: "browser" } }, expected), false);
  assert.equal(
    validateBootstrapAcknowledgement({ ...ack, sessionEntry: { kind: "http", method: "POST" } }, expected),
    false,
  );
  assert.equal(
    validateBootstrapAcknowledgement({ ...ack, status: "accepted" }, { ...expected, bootstrapId: "b".repeat(64) }),
    false,
  );
  assert.equal(validateBootstrapAcknowledgement({ ...ack, status: "blocked" }, expected), false);
  assert.equal(validateBootstrapAcknowledgement({ ...ack, extra: true }, expected), false);
  const hello = {
    schema: "gamebuddy-desktop-guardian-session/v1",
    protocolVersion: 1,
    operation: "hello",
    ...expected,
  };
  assert.equal(validateGuardianHelloRequest(hello, expected), true);
  assert.equal(validateGuardianHelloRequest({ ...hello, operation: "arm_attempt" }, expected), false);
  assert.equal(validateGuardianHelloRequest({ ...hello, bootstrapId: "b".repeat(64) }, expected), false);
  assert.equal(
    validateGuardianHelloRequest(
      { schema: "gamebuddy-desktop-host-bootstrap/v1", protocolVersion: 1, operation: "hello", ...expected },
      expected,
    ),
    false,
  );
});

/**
 * The ready frame's key sequence, read from the declaration beside the child that writes it.
 *
 * The child (`host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts`) writes that frame from a
 * literal object, so the declaration is its shape's one copy: the Host's wire test pins the real frame to
 * it (`desktop-runtime-bootstrap.internal.test.ts`), and this file builds every ready frame it needs from
 * it rather than restating it.
 */
const declaredReadyKeys = JSON.parse(
  readFileSync(new URL("../host/src/bootstrap/wire/desktop-composition-ready.keys.json", import.meta.url), "utf8"),
);

/** The ready frame a Host publishes over its readiness IPC, built key by key from the declaration above. */
function compositionReadyFrom(launchUrl) {
  const values = { schema: "gamebuddy-desktop-composition-ready/v1", protocolVersion: 1, launchUrl };
  return Object.fromEntries(declaredReadyKeys.map((key) => [key, values[key]]));
}

/**
 * The generation pointer's key sequence, read from the declaration beside the release publisher that writes
 * `current.json`, and compared below with the Desktop launcher's own C# list of the same frame.
 */
const declaredPointerKeys = JSON.parse(
  readFileSync(new URL("../host/scripts/host-generation-pointer.keys.json", import.meta.url), "utf8"),
);

/**
 * The ordered key list a C# call passes, read out of that call's own argument list.
 *
 * The Desktop launcher reads the same frames from C# (`InstalledGenerationSelection`,
 * `InstalledHostRuntimeAdmission`, `DesktopHostBootstrapBroker`), and it cannot share a declaration with this side: a
 * different language in a different build, reading a generation on the player's machine rather than a repository. The
 * two ends are compared here instead, and the scan is bracket-based so a reformat cannot change what it reads.
 */
/**
 * The ordered key list a C# call passes, read out of that call's own argument list.
 *
 * The scan is bracket-based, not line-based: `InstalledHostRuntimeAdmission` writes its eleven names on
 * one long line today, and a formatter that wrapped them must not change what this reads.
 */
function csharpDeclaredKeys(file, marker) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${file} must still name this call: ${marker}`);
  // The marker ends with the call's own `(`, so the argument list starts one level in.
  let depth = 1;
  let end = start + marker.length;
  for (let index = end; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  return [...source.slice(start + marker.length, end).matchAll(/"([A-Za-z][A-Za-z0-9]*)"/gu)].map((match) => match[1]);
}

test("the Desktop launcher's generation pointer is the declaration beside the publisher", () => {
  for (const file of [
    "desktop/GameBuddy.Desktop/InstalledGenerationSelection.cs",
    "desktop/GameBuddy.Desktop/InstalledGenerationRollback.cs",
  ])
    assert.deepEqual(
      csharpDeclaredKeys(file, "InstalledGenerationPaths.ExactProperties(root, "),
      declaredPointerKeys,
      `${file} reads current.json with a key sequence of its own`,
    );
});

const declaredAdmissionKeys = JSON.parse(
  readFileSync(new URL("../host/scripts/host-runtime-admission.keys.json", import.meta.url), "utf8"),
);

test("the Desktop launcher's runtime admission is the declaration beside the publisher", () => {
  assert.deepEqual(
    csharpDeclaredKeys(
      "desktop/GameBuddy.Desktop/InstalledHostRuntimeAdmission.cs",
      "InstalledGenerationPaths.ExactProperties(value, ",
    ),
    declaredAdmissionKeys,
    "InstalledHostRuntimeAdmission reads the sidecar with a key sequence of its own",
  );
});

const declaredHelloKeys = JSON.parse(
  readFileSync(new URL("../host/src/bootstrap/wire/desktop-guardian-session-hello.keys.json", import.meta.url), "utf8"),
);

test("the Desktop guardian broker's hello shape is the declaration beside the Host client", () => {
  assert.deepEqual(
    csharpDeclaredKeys("desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs", "ExactObject(hello, "),
    declaredHelloKeys,
    "DesktopHostBootstrapBroker reads the hello request with a key sequence of its own",
  );
});

test("composition launch validates the child IPC ready fact and composes the child environment", () => {
  assert.deepEqual(
    validateCompositionReadyMessage(compositionReadyFrom("http://127.0.0.1:4444/#profile=reference&boot=t")),
    true,
  );
  // The falsifier the acknowledgement's own defect was missing: a field the child publishes without the
  // declaration beside it is refused here, so a fourth key cannot ride along unread.
  assert.equal(
    validateCompositionReadyMessage({
      ...compositionReadyFrom("http://127.0.0.1:4444/#profile=reference&boot=t"),
      launchSurface: "chat-only",
    }),
    false,
  );
  assert.equal(
    validateCompositionReadyMessage({
      schema: "gamebuddy-desktop-composition-ready/v1",
      protocolVersion: 1,
      launchUrl: "not a url",
    }),
    false,
  );
  assert.equal(
    validateCompositionReadyMessage({
      schema: "gamebuddy-desktop-composition-ready/v1",
      protocolVersion: 2,
      launchUrl: "http://127.0.0.1:1/",
    }),
    false,
  );
  assert.equal(
    validateCompositionReadyMessage({ schema: "gamebuddy-desktop-composition-ready/v1", protocolVersion: 1 }),
    false,
  );

  const base = { LOCALAPPDATA: "C:/real", SystemRoot: "C:/Windows", TEMP: "C:/Windows/Temp" };
  const env = composeDesktopChildEnvironment({
    base,
    localAppDataRoot: "C:/fresh",
    manifestPath: "C:/fresh/dialogue.json",
    surface: "chat-only",
    nonceSha256: hex,
  });
  assert.equal(env.LOCALAPPDATA, "C:/fresh");
  assert.equal(env.GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST, "C:/fresh/dialogue.json");
  // The mount the Host performs - provision a new semantic authority or open the existing one - is
  // the Host's decision from the records in the runtime root, so the launcher neither decides it nor
  // publishes it. Both halves are asserted, because either one alone would let the flag come back:
  // absent from the declared block, AND ignored when a caller still passes the removed option
  // instead of silently acquiring this meaning.
  assert.equal("GAMEBUDDY_HOST_GAME_SESSION_MODE" in env, false);
  assert.equal(
    "GAMEBUDDY_HOST_GAME_SESSION_MODE" in
      composeDesktopChildEnvironment({
        base,
        localAppDataRoot: "C:/fresh",
        manifestPath: "C:/fresh/dialogue.json",
        gameSessionMode: "known",
      }),
    false,
  );
  assert.equal(env.GAMEBUDDY_HOST_SURFACE, "chat-only");
  assert.equal(env.GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256, hex);
  assert.equal(env.SystemRoot, "C:/Windows");
  // The launched Host is the embedded long-lived process by architecture; the flag is a contract
  // fact, not a test lever (declared omitting it made the composed child's historian gate fail).
  assert.equal(env.GAMEBUDDY_EMBEDDED_RUNTIME, "1");
  const minimal = composeDesktopChildEnvironment({
    base,
    localAppDataRoot: "C:/fresh",
    manifestPath: "C:/fresh/dialogue.json",
  });
  assert.equal(Object.hasOwn(minimal, "GAMEBUDDY_HOST_SURFACE"), false);
  assert.equal(Object.hasOwn(minimal, "GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256"), false);
  assert.throws(
    () => composeDesktopChildEnvironment({ base, localAppDataRoot: "C:/fresh", manifestPath: "" }),
    /desktop_compose_manifest_invalid/,
  );
});

test("composition launch child environment really redirects the child LOCALAPPDATA and gate env", () =>
  withRoot(async (root) => {
    const manifestPath = join(root, "dialogue.json");
    const env = composeDesktopChildEnvironment({
      base: { ...process.env, LOCALAPPDATA: "!original-value!" },
      localAppDataRoot: root,
      manifestPath,
      surface: "chat-only",
      nonceSha256: hex,
    });
    // A real child process observes the exact env object the launcher passes to
    // the bundled runtime: the fresh root is the child's LOCALAPPDATA, so the
    // wire validates it as the launcher-owned root layout (G7), and the gate
    // surface/nonce facts reach the composed surface through the same env.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({ localAppData: process.env.LOCALAPPDATA ?? null, surface: process.env.GAMEBUDDY_HOST_SURFACE ?? null, manifest: process.env.GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST ?? null, nonce: process.env.GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256 ?? null }))",
      ],
      { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    const code = await new Promise((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", resolveClose);
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(Buffer.concat(output).toString("utf8")), {
      localAppData: root,
      surface: "chat-only",
      manifest: manifestPath,
      nonce: hex,
    });
  }));

test("composition launch reads and rejects the production current pointer", () =>
  withRoot(async (root) => {
    const outputRoot = join(root, "dist");
    await mkdir(outputRoot, { recursive: true });
    const pointer = {
      schema: "gamebuddy-host-production-current/v2",
      generation: "g-1-2-3",
      inventoryDigest: hex,
      runtimeAdmissionSha256: hex,
    };
    await writeFile(join(outputRoot, "current.json"), `${JSON.stringify(pointer)}\n`);
    assert.deepEqual(await readProductionPointer({ outputRoot }), {
      generation: "g-1-2-3",
      inventoryDigest: hex,
      runtimeAdmissionSha256: hex,
    });
    await writeFile(join(outputRoot, "current.json"), `${JSON.stringify({ ...pointer, extra: true })}\n`);
    await assert.rejects(readProductionPointer({ outputRoot }), /desktop_compose_artifact_pointer_invalid/);
    await writeFile(join(outputRoot, "current.json"), `${JSON.stringify({ ...pointer, inventoryDigest: "x" })}\n`);
    await assert.rejects(readProductionPointer({ outputRoot }), /desktop_compose_artifact_pointer_invalid/);
    await rm(join(outputRoot, "current.json"));
    await assert.rejects(readProductionPointer({ outputRoot }), /desktop_compose_artifact_pointer_invalid/);
  }));

test("composition launch admits a generation exactly like the production launcher and rejects tamper", () =>
  withRoot(async (root) => {
    const outputRoot = join(root, "dist");
    const generation = "g-1-2-3";
    const artifactRoot = join(outputRoot, "generations", generation);
    const runtime = Buffer.from("fake node runtime");
    const bootstrap = Buffer.from("fake bootstrap entry");
    const admission = `${JSON.stringify({
      schema: "host-runtime-admission/v1",
      inventoryDigest: hex,
      generation,
      runtimePath: "runtime/node.exe",
      runtimeSha256: sha256(runtime),
      bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js",
      bootstrapSha256: sha256(bootstrap),
      runtimeVersion: "v24.20.0",
      runtimePlatform: "win32",
      runtimeArch: "x64",
      runtimeClosure: {
        schema: "host-bundled-runtime-closure/v1",
        files: [{ path: "runtime/node.exe", sha256: sha256(runtime) }],
      },
    })}\n`;
    await mkdir(join(artifactRoot, "runtime"), { recursive: true });
    await mkdir(join(artifactRoot, "bootstrap", "entry"), { recursive: true });
    await writeFile(join(artifactRoot, "runtime", "node.exe"), runtime);
    await writeFile(join(artifactRoot, "bootstrap", "entry", "desktop-host-entry.internal.js"), bootstrap);
    await writeFile(join(artifactRoot, "host-runtime-admission.json"), admission);
    const pointer = { generation, inventoryDigest: hex, runtimeAdmissionSha256: sha256(admission) };
    const admitted = await admitDesktopCompositionGeneration({ outputRoot, pointer });
    assert.equal(admitted.runtimePath, join(artifactRoot, "runtime", "node.exe"));
    assert.equal(admitted.bootstrapPath, join(artifactRoot, "bootstrap", "entry", "desktop-host-entry.internal.js"));
    // The closure shape is the publisher's and the production Desktop launcher's:
    // an object `{ schema, files[] }`. A bare array is not that shape.
    for (const runtimeClosure of [
      [],
      [{ path: "runtime/node.exe" }],
      { schema: "host-bundled-runtime-closure/v1", files: [] },
      { schema: "wrong-schema/v1", files: ["a"] },
      { files: ["a"] },
      { schema: "host-bundled-runtime-closure/v1", files: "a" },
    ]) {
      const mutated = `${JSON.stringify({ ...JSON.parse(admission), runtimeClosure })}\n`;
      await writeFile(join(artifactRoot, "host-runtime-admission.json"), mutated);
      await assert.rejects(
        admitDesktopCompositionGeneration({
          outputRoot,
          pointer: { ...pointer, runtimeAdmissionSha256: sha256(mutated) },
        }),
        /desktop_compose_runtime_admission_invalid/,
      );
    }
    await writeFile(join(artifactRoot, "host-runtime-admission.json"), admission);
    await writeFile(join(artifactRoot, "runtime", "node.exe"), Buffer.from("tampered runtime"));
    await assert.rejects(
      admitDesktopCompositionGeneration({ outputRoot, pointer }),
      /desktop_compose_runtime_admission_mismatch/,
    );
  }));

test("composition launch installs the generation and the entry-owned inspector pair into the fresh root", () =>
  withRoot(async (root) => {
    const outputRoot = join(root, "dist");
    const generation = "g-1-2-3";
    const artifactRoot = join(outputRoot, "generations", generation);
    const inspectorRoot = join(artifactRoot, "native", "windows-reparse-inspector", "win-x64");
    const inspectorHelper = Buffer.from("fake inspector");
    await mkdir(inspectorRoot, { recursive: true });
    await writeFile(join(inspectorRoot, "GameBuddy.WindowsReparseInspector.exe"), inspectorHelper);
    await writeFile(
      join(inspectorRoot, "windows-reparse-inspector.manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, protocolVersion: 1, rid: "win-x64", helperFileName: "GameBuddy.WindowsReparseInspector.exe", sha256: sha256(inspectorHelper) })}\n`,
    );
    await writeFile(
      join(artifactRoot, "production-inventory.json"),
      `${JSON.stringify({ schema: "gamebuddy-host-production-inventory/v4", entries: [], digest: hex })}\n`,
    );
    const layout = createDesktopCompositionRootLayout(root, generation);
    await installDesktopCompositionGeneration({ artifactRoot, rootLayout: layout });
    assert.equal(
      (await readFile(join(layout.generationRoot, "production-inventory.json"), "utf8")).includes(
        "gamebuddy-host-production-inventory/v4",
      ),
      true,
    );
    assert.equal(
      await readFile(
        join(
          layout.moduleDirectory,
          "native",
          "windows-reparse-inspector",
          "win-x64",
          "GameBuddy.WindowsReparseInspector.exe",
        ),
        "utf8",
      ),
      "fake inspector",
    );
  }));

test("desktop composition launch never references the removed entry or the chat-live machine", async () => {
  const source = await readFile(
    resolve(fileURLToPath(new URL(".", import.meta.url)), "desktop-composition-launch.mjs"),
    "utf8",
  );
  assert.match(source, /desktop-host-entry\.internal\.js/);
  // The guardian endpoint is no longer spelled here: `tools/lib/guardian-role-broker.mjs` owns the
  // session (and its own test asserts the spelling), so what this launcher must be seen doing is
  // reaching that peer rather than binding a look-alike of it.
  assert.match(source, /from "\.\/lib\/guardian-role-broker\.mjs"/);
  assert.doesNotMatch(
    source,
    /dialogue-web-main|start-production-artifact|chat-tavern-live|CHAT_LIVE_ARTIFACT|GAMEBUDDY_CHAT_LIVE_ARTIFACT/,
  );
});

test("the launcher spawns the INSTALLED generation, never the artifact path", () =>
  withRoot(async (root) => {
    // Regression: the bootstrap validates that its own module directory is inside
    // the child's `rootLayout.programRoot`. The artifact path is never inside it
    // once the generation is published outside the repository, so spawning the
    // artifact made every installed/composed run die with
    // `desktop_runtime_bootstrap_unavailable` before the child could report
    // anything. The install step exists to give the child its launcher-shaped
    // root, and the production Desktop launcher starts the installed generation.
    const outputRoot = join(root, "dist");
    const generation = "g-1-2-3";
    const artifactRoot = join(outputRoot, "generations", generation);
    const runtime = Buffer.from("fake node runtime");
    const bootstrap = Buffer.from("fake bootstrap entry");
    const admission = `${JSON.stringify({
      schema: "host-runtime-admission/v1",
      inventoryDigest: hex,
      generation,
      runtimePath: "runtime/node.exe",
      runtimeSha256: sha256(runtime),
      bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js",
      bootstrapSha256: sha256(bootstrap),
      runtimeVersion: "v24.20.0",
      runtimePlatform: "win32",
      runtimeArch: "x64",
      runtimeClosure: {
        schema: "host-bundled-runtime-closure/v1",
        files: [{ path: "runtime/CHANGELOG.md", sha256: sha256(runtime) }],
      },
    })}\n`;
    await mkdir(join(artifactRoot, "runtime"), { recursive: true });
    await mkdir(join(artifactRoot, "bootstrap", "entry"), { recursive: true });
    await writeFile(join(artifactRoot, "runtime", "node.exe"), runtime);
    await writeFile(join(artifactRoot, "bootstrap", "entry", "desktop-host-entry.internal.js"), bootstrap);
    await writeFile(join(artifactRoot, "host-runtime-admission.json"), admission);
    await writeFile(
      join(outputRoot, "current.json"),
      `${JSON.stringify({ schema: "gamebuddy-host-production-current/v2", generation, inventoryDigest: hex, runtimeAdmissionSha256: sha256(admission) })}\n`,
    );
    // The install step also stages the entry-owned reparse-inspector pair, so the
    // fixture must carry it or the install fails before the spawn is reached.
    const inspectorRoot = join(artifactRoot, "native", "windows-reparse-inspector", "win-x64");
    await mkdir(inspectorRoot, { recursive: true });
    await writeFile(join(inspectorRoot, "GameBuddy.WindowsReparseInspector.exe"), Buffer.from("fake inspector"));

    const layout = createDesktopCompositionRootLayout(root, generation);
    let spawned;
    let launched;
    // Stub only the OS process: the launcher's own admission, install and path
    // selection all run for real, and the captured spawn is what gets asserted.
    // The stub child then exits so the launch settles instead of waiting.
    const launch = await launchDesktopCompositionGateChild({
      outputRoot,
      root,
      surface: "chat-only",
      nonceSha256: "a".repeat(64),
      manifestPath: join(root, "deployment.json"),
      readyTimeoutMs: 5_000,
      spawnImpl: (command, args, options) => {
        spawned = { command, args, cwd: options?.cwd };
        // A cooperative stub: it satisfies the launcher's own wire handshake
        // (bootstrap ack on stdout, guardian hello over the real pipe, ready on
        // IPC) so the launch resolves and the captured spawn can be asserted,
        // without starting a real child process.
        const fake = new EventEmitter();
        fake.stdout = new EventEmitter();
        fake.stderr = new EventEmitter();
        fake.pid = 1234;
        fake.kill = () => true;
        fake.stdin = {
          write: (frameText) => {
            queueMicrotask(() => {
              const frame = JSON.parse(String(frameText));
              fake.stdout.emit("data", `${JSON.stringify(acknowledgementFrom(frame))}\n`);
              // The launcher awaits the guardian hello before returning, so the
              // stub must complete that session on the real endpoint.
              const socket = createConnection(`\\\\.\\pipe\\GameBuddy.HostGuardian.${frame.bootstrapId}`);
              socket.once("connect", () => {
                const helloValues = {
                  schema: "gamebuddy-desktop-guardian-session/v1",
                  protocolVersion: 1,
                  operation: "hello",
                  bootstrapId: frame.bootstrapId,
                  generation: frame.generation,
                  inventoryDigest: frame.inventoryDigest,
                  runtimeAdmissionSha256: frame.runtimeAdmissionSha256,
                };
                socket.write(
                  `${JSON.stringify(Object.fromEntries(declaredHelloKeys.map((key) => [key, helloValues[key]])))}\n`,
                );
              });
              socket.on("error", () => undefined);
              fake.emit("message", compositionReadyFrom("http://127.0.0.1:1/#profile=reference"));
            });
            return true;
          },
          end: () => true,
        };
        return fake;
      },
    }).then(
      (value) => {
        launched = value;
        return undefined;
      },
      (error) => error,
    );

    try {
      assert.ok(
        spawned !== undefined,
        `spawn must happen (launch settled as ${String(launch?.message ?? "resolved")})`,
      );
      assert.equal(spawned.cwd, layout.generationRoot);
      // The decisive assertion: both runtime and entry come from the installed
      // generation, never from the artifact tree.
      assert.equal(spawned.command, join(layout.generationRoot, "runtime", "node.exe"));
      assert.deepEqual(spawned.args, [
        join(layout.generationRoot, "bootstrap", "entry", "desktop-host-entry.internal.js"),
      ]);
      assert.equal(spawned.command.startsWith(artifactRoot), false);
      assert.equal(spawned.args[0].startsWith(artifactRoot), false);
      // The honest isolation subject travels with the launch handle, and it reads the run's own
      // manifest instead of re-deriving the declared directories.
      assert.equal(typeof launched.measureRunRoots, "function");
      await assert.rejects(() => launched.measureRunRoots(), /desktop_compose_manifest_unreadable/);
    } finally {
      // The launch opens a real guardian-session named-pipe server that the stub
      // answers over a real client socket. Both are live event-loop handles: an
      // undisposed peer is what kept this process alive after the last
      // assertion, so the launch is torn down even when an assertion fails.
      launched?.dispose();
    }
  }));
