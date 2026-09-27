import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  admitDesktopCompositionGeneration,
  composeDesktopBootstrapFrame,
  composeDesktopChildEnvironment,
  createDesktopCompositionRootLayout,
  installDesktopCompositionGeneration,
  launchDesktopCompositionGateChild,
  readProductionPointer,
  validateBootstrapAcknowledgement,
  validateCompositionNonceDigest,
  validateCompositionReadyMessage,
  validateCompositionSurface,
  validateGuardianHelloRequest,
} from "./desktop-composition-launch.mjs";

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
  assert.throws(() => createDesktopCompositionRootLayout("C:\\fresh", "bad generation"), /desktop_compose_generation_invalid/);
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
  assert.throws(() => composeDesktopBootstrapFrame({ bootstrapId: "x", generation: "g-1", inventoryDigest: hex, runtimeAdmissionSha256: hex, rootLayout: layout }), /desktop_compose_frame_invalid/);
});

test("composition launch validates the bootstrap acknowledgement and guardian hello with exact binding facts", () => {
  const expected = { bootstrapId: hex, generation: "g-1", inventoryDigest: hex, runtimeAdmissionSha256: hex };
  const ack = {
    schema: "gamebuddy-desktop-host-bootstrap/v1",
    protocolVersion: 1,
    status: "accepted",
    ...expected,
    rootLayoutSchema: "gamebuddy-windows-root-layout/v1",
  };
  assert.equal(validateBootstrapAcknowledgement(ack, expected), true);
  assert.equal(validateBootstrapAcknowledgement({ ...ack, status: "accepted" }, { ...expected, bootstrapId: "b".repeat(64) }), false);
  assert.equal(validateBootstrapAcknowledgement({ ...ack, status: "blocked" }, expected), false);
  assert.equal(validateBootstrapAcknowledgement({ ...ack, extra: true }, expected), false);
  const hello = { schema: "gamebuddy-desktop-guardian-session/v1", protocolVersion: 1, operation: "hello", ...expected };
  assert.equal(validateGuardianHelloRequest(hello, expected), true);
  assert.equal(validateGuardianHelloRequest({ ...hello, operation: "arm_attempt" }, expected), false);
  assert.equal(validateGuardianHelloRequest({ ...hello, bootstrapId: "b".repeat(64) }, expected), false);
  assert.equal(validateGuardianHelloRequest({ schema: "gamebuddy-desktop-host-bootstrap/v1", protocolVersion: 1, operation: "hello", ...expected }, expected), false);
});

test("composition launch validates the child IPC ready fact and composes the child environment", () => {
  assert.deepEqual(validateCompositionReadyMessage({ schema: "gamebuddy-desktop-composition-ready/v1", protocolVersion: 1, launchUrl: "http://127.0.0.1:4444/#profile=reference&boot=t" }), true);
  assert.equal(validateCompositionReadyMessage({ schema: "gamebuddy-desktop-composition-ready/v1", protocolVersion: 1, launchUrl: "not a url" }), false);
  assert.equal(validateCompositionReadyMessage({ schema: "gamebuddy-desktop-composition-ready/v1", protocolVersion: 2, launchUrl: "http://127.0.0.1:1/" }), false);
  assert.equal(validateCompositionReadyMessage({ schema: "gamebuddy-desktop-composition-ready/v1", protocolVersion: 1 }), false);

  const base = { LOCALAPPDATA: "C:/real", SystemRoot: "C:/Windows", TEMP: "C:/Windows/Temp" };
  const env = composeDesktopChildEnvironment({ base, localAppDataRoot: "C:/fresh", manifestPath: "C:/fresh/dialogue.json", surface: "chat-only", nonceSha256: hex });
  assert.equal(env.LOCALAPPDATA, "C:/fresh");
  assert.equal(env.GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST, "C:/fresh/dialogue.json");
  assert.equal(env.GAMEBUDDY_HOST_GAME_SESSION_MODE, "fresh");
  assert.equal(env.GAMEBUDDY_HOST_SURFACE, "chat-only");
  assert.equal(env.GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256, hex);
  assert.equal(env.SystemRoot, "C:/Windows");
  const minimal = composeDesktopChildEnvironment({ base, localAppDataRoot: "C:/fresh", manifestPath: "C:/fresh/dialogue.json" });
  assert.equal(Object.hasOwn(minimal, "GAMEBUDDY_HOST_SURFACE"), false);
  assert.equal(Object.hasOwn(minimal, "GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256"), false);
  assert.throws(() => composeDesktopChildEnvironment({ base, localAppDataRoot: "C:/fresh", manifestPath: "" }), /desktop_compose_manifest_invalid/);
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
      ["-e", "process.stdout.write(JSON.stringify({ localAppData: process.env.LOCALAPPDATA ?? null, surface: process.env.GAMEBUDDY_HOST_SURFACE ?? null, manifest: process.env.GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST ?? null, nonce: process.env.GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256 ?? null }))"],
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
    const pointer = { schema: "gamebuddy-host-production-current/v2", generation: "g-1-2-3", inventoryDigest: hex, runtimeAdmissionSha256: hex };
    await writeFile(join(outputRoot, "current.json"), `${JSON.stringify(pointer)}\n`);
    assert.deepEqual(await readProductionPointer({ outputRoot }), { generation: "g-1-2-3", inventoryDigest: hex, runtimeAdmissionSha256: hex });
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
      runtimeClosure: { schema: "host-bundled-runtime-closure/v1", files: [{ path: "runtime/node.exe", sha256: sha256(runtime) }] },
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
    await assert.rejects(admitDesktopCompositionGeneration({ outputRoot, pointer }), /desktop_compose_runtime_admission_mismatch/);
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
    await writeFile(join(inspectorRoot, "windows-reparse-inspector.manifest.json"), `${JSON.stringify({ schemaVersion: 1, protocolVersion: 1, rid: "win-x64", helperFileName: "GameBuddy.WindowsReparseInspector.exe", sha256: sha256(inspectorHelper) })}\n`);
    await writeFile(join(artifactRoot, "production-inventory.json"), `${JSON.stringify({ schema: "gamebuddy-host-production-inventory/v4", entries: [], digest: hex })}\n`);
    const layout = createDesktopCompositionRootLayout(root, generation);
    await installDesktopCompositionGeneration({ artifactRoot, rootLayout: layout });
    assert.equal((await readFile(join(layout.generationRoot, "production-inventory.json"), "utf8")).includes("gamebuddy-host-production-inventory/v4"), true);
    assert.equal(
      await readFile(join(layout.moduleDirectory, "native", "windows-reparse-inspector", "win-x64", "GameBuddy.WindowsReparseInspector.exe"), "utf8"),
      "fake inspector",
    );
  }));

test("desktop composition launch never references the removed entry or the chat-live machine", async () => {
  const source = await readFile(resolve(fileURLToPath(new URL(".", import.meta.url)), "desktop-composition-launch.mjs"), "utf8");
  assert.match(source, /desktop-host-entry\.internal\.js/);
  assert.match(source, /GameBuddy\.HostGuardian\.\$\{bootstrapId\}/);
  assert.doesNotMatch(source, /dialogue-web-main|start-production-artifact|chat-tavern-live|CHAT_LIVE_ARTIFACT|GAMEBUDDY_CHAT_LIVE_ARTIFACT/);
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
      runtimeClosure: { schema: "host-bundled-runtime-closure/v1", files: [{ path: "runtime/CHANGELOG.md", sha256: sha256(runtime) }] },
    })}\n`;
    await mkdir(join(artifactRoot, "runtime"), { recursive: true });
    await mkdir(join(artifactRoot, "bootstrap", "entry"), { recursive: true });
    await writeFile(join(artifactRoot, "runtime", "node.exe"), runtime);
    await writeFile(join(artifactRoot, "bootstrap", "entry", "desktop-host-entry.internal.js"), bootstrap);
    await writeFile(join(artifactRoot, "host-runtime-admission.json"), admission);
    await writeFile(join(outputRoot, "current.json"), `${JSON.stringify({ schema: "gamebuddy-host-production-current/v2", generation, inventoryDigest: hex, runtimeAdmissionSha256: sha256(admission) })}\n`);
    // The install step also stages the entry-owned reparse-inspector pair, so the
    // fixture must carry it or the install fails before the spawn is reached.
    const inspectorRoot = join(artifactRoot, "native", "windows-reparse-inspector", "win-x64");
    await mkdir(inspectorRoot, { recursive: true });
    await writeFile(join(inspectorRoot, "GameBuddy.WindowsReparseInspector.exe"), Buffer.from("fake inspector"));

    const layout = createDesktopCompositionRootLayout(root, generation);
    let spawned;
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
              fake.stdout.emit(
                "data",
                `${JSON.stringify({
                  schema: "gamebuddy-desktop-host-bootstrap/v1",
                  protocolVersion: 1,
                  status: "accepted",
                  bootstrapId: frame.bootstrapId,
                  generation: frame.generation,
                  inventoryDigest: frame.inventoryDigest,
                  runtimeAdmissionSha256: frame.runtimeAdmissionSha256,
                  rootLayoutSchema: frame.rootLayout.schema,
                })}\n`,
              );
              // The launcher awaits the guardian hello before returning, so the
              // stub must complete that session on the real endpoint.
              const socket = createConnection(`\\\\.\\pipe\\GameBuddy.HostGuardian.${frame.bootstrapId}`);
              socket.once("connect", () => {
                socket.write(
                  `${JSON.stringify({
                    schema: "gamebuddy-desktop-guardian-session/v1",
                    protocolVersion: 1,
                    operation: "hello",
                    bootstrapId: frame.bootstrapId,
                    generation: frame.generation,
                    inventoryDigest: frame.inventoryDigest,
                    runtimeAdmissionSha256: frame.runtimeAdmissionSha256,
                  })}\n`,
                );
              });
              socket.on("error", () => undefined);
              fake.emit("message", { schema: "gamebuddy-desktop-composition-ready/v1", protocolVersion: 1, launchUrl: "http://127.0.0.1:1/#profile=reference" });
            });
            return true;
          },
          end: () => true,
        };
        return fake;
      },
    }).then(
      () => undefined,
      (error) => error,
    );

    assert.ok(spawned !== undefined, `spawn must happen (launch settled as ${String(launch?.message ?? "resolved")})`);
    assert.equal(spawned.cwd, layout.generationRoot);
    // The decisive assertion: both runtime and entry come from the installed
    // generation, never from the artifact tree.
    assert.equal(spawned.command, join(layout.generationRoot, "runtime", "node.exe"));
    assert.deepEqual(spawned.args, [join(layout.generationRoot, "bootstrap", "entry", "desktop-host-entry.internal.js")]);
    assert.equal(spawned.command.startsWith(artifactRoot), false);
    assert.equal(spawned.args[0].startsWith(artifactRoot), false);
  }));
