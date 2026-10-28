#!/usr/bin/env node
/**
 * Desktop composition bootstrap for the fresh-root Tavern gates.
 *
 * The final gate is the Desktop composition bootstrap itself: it drives the
 * single formal Host entry (bundled runtime + `bootstrap/entry/
 * desktop-host-entry.internal.js`) through the exact private bootstrap wire the
 * production Desktop launcher speaks, against a fresh gate-owned root that the
 * child validates as its launcher-owned root layout (LOCALAPPDATA-relative,
 * mirroring `gamebuddy-windows-root-layout/v1`). There is no second entry,
 * alias, or fallback: the gate plays the launcher/broker role the Desktop app
 * plays in production, including the guardian-session pipe peer that answers
 * the wire's `hello` with the exact binding facts. Stardew containment
 * (`arm_attempt`/`launch_role`/`contain_role`) is deliberately never forged:
 * any non-hello guardian frame destroys the session so the wire fails closed.
 *
 * The composed surface launch URL is delivered over the child IPC channel as
 * `gamebuddy-desktop-composition-ready/v1`, so the production stdout ack
 * contract (one line, ended by EOF) stays intact for the Desktop launcher.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const BOOTSTRAP_SCHEMA = "gamebuddy-desktop-host-bootstrap/v1";
const GUARDIAN_SESSION_SCHEMA = "gamebuddy-desktop-guardian-session/v1";
const ROOT_LAYOUT_SCHEMA = "gamebuddy-windows-root-layout/v1";
const READY_SCHEMA = "gamebuddy-desktop-composition-ready/v1";
/**
 * The Host now narrates startup on stdout before its acknowledgement: one bounded status frame per
 * step (`gamebuddy-desktop-host-bootstrap-status/v1`, carrying a stage and maybe a waiting token).
 * This launcher's whole job on that channel is to tell those frames from the acknowledgement - the
 * acknowledgement is the first line that is not one of them. Reading the first line as the
 * acknowledgement made every composed launch fail with `desktop_compose_bootstrap_ack_invalid` as
 * soon as the status channel shipped (commit 2e8672d9).
 */
const BOOTSTRAP_STATUS_SCHEMA = "gamebuddy-desktop-host-bootstrap-status/v1";
const POINTER_SCHEMA = "gamebuddy-host-production-current/v2";
const RUNTIME_ADMISSION_SCHEMA = "host-runtime-admission/v1";
const MAX_GUARDIAN_FRAME_BYTES = 16_384;
const GUARDIAN_HELLO_TIMEOUT_MS = 30_000;

export const COMPOSITION_SURFACES = Object.freeze(["composed-reference-game", "chat-only", "management"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hex64 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exactKeysInOrder = (value, expected) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

export function validateCompositionSurface(value) {
  return value === undefined || COMPOSITION_SURFACES.includes(value);
}

/**
 * The bundled-runtime closure is owned by the publisher, and the gate consumes
 * the same shape the production Desktop launcher consumes: an object
 * `{ schema: "host-bundled-runtime-closure/v1", files: [...] }`. Only the shape
 * needed to admit the generation is checked here; full membership and ordering
 * remain the publisher's release gate.
 */
function isRuntimeClosure(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schema === "host-bundled-runtime-closure/v1" &&
    Array.isArray(value.files) &&
    value.files.length > 0
  );
}

export function validateCompositionNonceDigest(value) {
  return value === undefined || hex64(value);
}

export function desktopCompositionMutableRootPaths(localAppDataRoot) {
  if (typeof localAppDataRoot !== "string" || localAppDataRoot.length === 0)
    throw new Error("desktop_compose_root_invalid");
  return Object.freeze({
    data: join(localAppDataRoot, "GameBuddy", "data"),
    operational: join(localAppDataRoot, "GameBuddy", "operational"),
    presentation: join(localAppDataRoot, "GameBuddy", "presentation"),
  });
}

export function createDesktopCompositionRootLayout(localAppDataRoot, generation) {
  if (typeof generation !== "string" || !/^[a-z0-9-]+$/i.test(generation))
    throw new Error("desktop_compose_generation_invalid");
  const mutable = desktopCompositionMutableRootPaths(localAppDataRoot);
  return Object.freeze({
    programRoot: join(localAppDataRoot, "Programs", "GameBuddy"),
    dataRoot: mutable.data,
    operationalRoot: mutable.operational,
    presentationRoot: mutable.presentation,
    generationRoot: join(localAppDataRoot, "Programs", "GameBuddy", generation),
    moduleDirectory: join(localAppDataRoot, "Programs", "GameBuddy", generation, "bootstrap", "entry"),
  });
}

/**
 * The deployment manifest's `runtimeRoot` is the ISOLATION CLAIM'S SUBJECT: the Host resolves its
 * mutable roots from it (`host/src/deployment-manifest.ts` -> `resolveRuntimePaths`), and
 * production provisioning pins it to the declared data root
 * (`desktop/GameBuddy.Desktop.Tests/DeploymentIdentityTests.cs` asserts
 * `layout.DataRoot === manifest.runtimeRoot`). An assertion that looks only at the bootstrap frame's
 * declared `GameBuddy\{data,operational,presentation}` can therefore report a run that wrote tens of
 * thousands of files as "the temp root is empty" whenever `runtimeRoot` names a different directory
 * (the harness authored `runtimeRoot` = the temp root itself). Read the subject from the run's own
 * manifest instead of assuming it.
 */
export async function readDesktopCompositionRuntimeRoot({ manifestPath }) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0)
    throw new Error("desktop_compose_manifest_invalid");
  let value;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("desktop_compose_manifest_unreadable");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.runtimeRoot !== "string" ||
    value.runtimeRoot.length === 0
  )
    throw new Error("desktop_compose_manifest_runtime_root_invalid");
  return resolve(value.runtimeRoot);
}

async function filesUnder(directory, { excludeDirectories = [] } = {}) {
  const excluded = new Set(excludeDirectories.map((path) => resolve(path)));
  const files = [];
  const visit = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(resolve(full))) continue;
        await visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  await visit(directory);
  return files;
}

/**
 * Measures the run's roots as they actually are: each declared mutable root, and the directory the
 * manifest's `runtimeRoot` names (the child's real data root). The launcher's own installed
 * generation under `Programs\GameBuddy` is excluded from the resolved measurement because the
 * launcher - not the child - writes it.
 */
export async function measureDesktopCompositionRunRoots({ root, runtimeRoot }) {
  if (typeof root !== "string" || root.length === 0) throw new Error("desktop_compose_root_invalid");
  if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0)
    throw new Error("desktop_compose_runtime_root_invalid");
  const declared = {};
  let declaredFileCount = 0;
  for (const [name, path] of Object.entries(desktopCompositionMutableRootPaths(root))) {
    let entries = [];
    let exists = false;
    try {
      entries = (await readdir(path)).sort();
      exists = true;
    } catch {
      entries = [];
    }
    const fileCount = (await filesUnder(path)).length;
    declaredFileCount += fileCount;
    declared[name] = Object.freeze({
      path,
      exists,
      entryCount: entries.length,
      entries: Object.freeze(entries),
      fileCount,
    });
  }
  const programRoot = join(root, "Programs", "GameBuddy");
  const resolvedFileCount = (await filesUnder(runtimeRoot, { excludeDirectories: [programRoot] })).length;
  return Object.freeze({
    root: resolve(root),
    runtimeRoot: resolve(runtimeRoot),
    programRoot,
    declared: Object.freeze(declared),
    declaredFileCount,
    resolved: Object.freeze({ path: resolve(runtimeRoot), fileCount: resolvedFileCount }),
  });
}

/**
 * Fails closed when the run's content is not where the root layout declared it: content under the
 * manifest's `runtimeRoot` while every declared mutable root is empty means the composed layout was
 * not the layout the child used, which is exactly the state that reads as "the temp root is empty".
 * Run this on the post-run measurement; nothing is written yet before a run, so a resolved count of
 * zero passes.
 */
export function assertDesktopCompositionRunRoots(measurement) {
  if (measurement === null || typeof measurement !== "object" || Array.isArray(measurement))
    throw new Error("desktop_compose_run_roots_invalid");
  const { declared, declaredFileCount, resolved, root } = measurement;
  if (resolved?.fileCount > 0 && declaredFileCount === 0) {
    const names = Object.values(declared ?? {}).map((entry) => entry.path);
    throw new Error(
      `desktop_compose_run_roots_declared_layout_unused: ${root} holds ${resolved.fileCount} file(s) ` +
        `under its manifest runtimeRoot ${resolved.path} while the declared mutable roots ` +
        `(${names.join(", ")}) are empty`,
    );
  }
  return measurement;
}

export function composeDesktopBootstrapFrame({
  bootstrapId,
  generation,
  inventoryDigest,
  runtimeAdmissionSha256,
  rootLayout,
}) {
  if (!hex64(bootstrapId) || !hex64(inventoryDigest) || !hex64(runtimeAdmissionSha256))
    throw new Error("desktop_compose_frame_invalid");
  return Object.freeze({
    schema: BOOTSTRAP_SCHEMA,
    protocolVersion: 1,
    bootstrapId,
    generation,
    inventoryDigest,
    runtimeAdmissionSha256,
    rootLayout: Object.freeze({
      schema: ROOT_LAYOUT_SCHEMA,
      programRoot: rootLayout.programRoot,
      dataRoot: rootLayout.dataRoot,
      operationalRoot: rootLayout.operationalRoot,
      presentationRoot: rootLayout.presentationRoot,
    }),
  });
}

export function validateBootstrapAcknowledgement(value, expected) {
  return (
    exactKeysInOrder(value, [
      "schema",
      "protocolVersion",
      "status",
      "bootstrapId",
      "generation",
      "inventoryDigest",
      "runtimeAdmissionSha256",
      "rootLayoutSchema",
      "sessionEntry",
    ]) &&
    value.schema === BOOTSTRAP_SCHEMA &&
    value.protocolVersion === 1 &&
    value.status === "accepted" &&
    value.bootstrapId === expected.bootstrapId &&
    value.generation === expected.generation &&
    value.inventoryDigest === expected.inventoryDigest &&
    value.runtimeAdmissionSha256 === expected.runtimeAdmissionSha256 &&
    value.rootLayoutSchema === ROOT_LAYOUT_SCHEMA &&
    isSessionEntry(value.sessionEntry)
  );
}

/**
 * The session entry the Host published: either an HTTP token exchange the harness can perform, or a browser
 * fragment it cannot. Callers must read this instead of assuming the management route; assuming it is how a
 * 404 `profile_operation_unavailable` became a day-long mystery.
 */
function isSessionEntry(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.kind === "browser")
    return typeof value.launchPath === "string" && typeof value.bootFragmentKey === "string";
  return (
    value.kind === "http" &&
    value.method === "POST" &&
    typeof value.route === "string" &&
    Array.isArray(value.bodyKeys) &&
    value.bodyKeys.every((key) => typeof key === "string")
  );
}

export function validateGuardianHelloRequest(value, expected) {
  return (
    exactKeysInOrder(value, [
      "schema",
      "protocolVersion",
      "operation",
      "bootstrapId",
      "generation",
      "inventoryDigest",
      "runtimeAdmissionSha256",
    ]) &&
    value.schema === GUARDIAN_SESSION_SCHEMA &&
    value.protocolVersion === 1 &&
    value.operation === "hello" &&
    value.bootstrapId === expected.bootstrapId &&
    value.generation === expected.generation &&
    value.inventoryDigest === expected.inventoryDigest &&
    value.runtimeAdmissionSha256 === expected.runtimeAdmissionSha256
  );
}

export function validateCompositionReadyMessage(value) {
  return (
    exactKeysInOrder(value, ["schema", "protocolVersion", "launchUrl"]) &&
    value.schema === READY_SCHEMA &&
    value.protocolVersion === 1 &&
    typeof value.launchUrl === "string" &&
    /^https?:\/\/[^/\s]+/.test(value.launchUrl)
  );
}

export function composeDesktopChildEnvironment({
  base,
  localAppDataRoot,
  manifestPath,
  surface = undefined,
  nonceSha256 = undefined,
  gameSessionMode = "fresh",
}) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0)
    throw new Error("desktop_compose_manifest_invalid");
  if (gameSessionMode !== "fresh" && gameSessionMode !== "known")
    throw new Error("desktop_compose_session_mode_invalid");
  return Object.freeze({
    ...base,
    LOCALAPPDATA: localAppDataRoot,
    GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST: manifestPath,
    GAMEBUDDY_HOST_GAME_SESSION_MODE: gameSessionMode,
    // The launched Host is the embedded long-lived process by architecture: it never spawns the `pi`
    // CLI, and the Magic Context fork gates its background historian on exactly this flag
    // (`pi-background-run-lifetime.ts`: a headless process with no UI may only run the historian when it
    // declares that it outlives background runs). Omitting it here means the composed child's own
    // runtime deletes it after construction and every later historian trigger fails closed - so a
    // production player would never get a fold either. It is a contract fact, not a test lever, so it is
    // declared unconditionally.
    GAMEBUDDY_EMBEDDED_RUNTIME: "1",
    ...(surface === undefined ? {} : { GAMEBUDDY_HOST_SURFACE: surface }),
    ...(nonceSha256 === undefined ? {} : { GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256: nonceSha256 }),
  });
}

export async function readProductionPointer({ outputRoot }) {
  let value;
  try {
    value = JSON.parse(await readFile(join(outputRoot, "current.json"), "utf8"));
  } catch {
    throw new Error("desktop_compose_artifact_pointer_invalid");
  }
  if (
    !exactKeysInOrder(value, ["schema", "generation", "inventoryDigest", "runtimeAdmissionSha256"]) ||
    value.schema !== POINTER_SCHEMA ||
    typeof value.generation !== "string" ||
    !/^[a-z0-9-]+$/i.test(value.generation) ||
    !hex64(value.inventoryDigest) ||
    !hex64(value.runtimeAdmissionSha256)
  )
    throw new Error("desktop_compose_artifact_pointer_invalid");
  return Object.freeze({
    generation: value.generation,
    inventoryDigest: value.inventoryDigest,
    runtimeAdmissionSha256: value.runtimeAdmissionSha256,
  });
}

async function regularFile(path, label) {
  let state;
  try {
    state = await lstat(path);
  } catch {
    throw new Error(`desktop_compose_${label}_missing`);
  }
  if (state.isSymbolicLink() || !state.isFile()) throw new Error(`desktop_compose_${label}_invalid`);
  return state;
}

async function regularDirectory(path, label) {
  let state;
  try {
    state = await lstat(path);
  } catch {
    throw new Error(`desktop_compose_${label}_missing`);
  }
  if (state.isSymbolicLink() || !state.isDirectory()) throw new Error(`desktop_compose_${label}_invalid`);
  return state;
}

/**
 * Bounded run admission over the selected immutable generation: the pointer is
 * bound to the exact `host-runtime-admission.json` sidecar, the sidecar facts
 * bind the generation and entry layout, and the runtime + bootstrap files are
 * re-hashed against the sidecar exactly like the production launcher's admit
 * path. Full inventory verification remains the publisher's release gate.
 */
export async function admitDesktopCompositionGeneration({ outputRoot, pointer }) {
  const artifactRoot = resolve(outputRoot, "generations", pointer.generation);
  await regularDirectory(artifactRoot, "generation");
  const runtimePath = join(artifactRoot, "runtime", "node.exe");
  const bootstrapPath = join(artifactRoot, "bootstrap", "entry", "desktop-host-entry.internal.js");
  await regularFile(runtimePath, "runtime");
  await regularFile(bootstrapPath, "bootstrap");
  const admissionPath = join(artifactRoot, "host-runtime-admission.json");
  let admissionBytes;
  try {
    admissionBytes = await readFile(admissionPath);
  } catch {
    throw new Error("desktop_compose_runtime_admission_mismatch");
  }
  if (sha256(admissionBytes) !== pointer.runtimeAdmissionSha256)
    throw new Error("desktop_compose_runtime_admission_mismatch");
  let admission;
  try {
    admission = JSON.parse(admissionBytes.toString("utf8"));
  } catch {
    throw new Error("desktop_compose_runtime_admission_invalid");
  }
  if (
    !exactKeysInOrder(admission, [
      "schema",
      "inventoryDigest",
      "generation",
      "runtimePath",
      "runtimeSha256",
      "bootstrapPath",
      "bootstrapSha256",
      "runtimeVersion",
      "runtimePlatform",
      "runtimeArch",
      "runtimeClosure",
    ]) ||
    admission.schema !== RUNTIME_ADMISSION_SCHEMA ||
    admission.inventoryDigest !== pointer.inventoryDigest ||
    admission.generation !== pointer.generation ||
    admission.runtimePath !== "runtime/node.exe" ||
    admission.bootstrapPath !== "bootstrap/entry/desktop-host-entry.internal.js" ||
    !hex64(admission.runtimeSha256) ||
    !hex64(admission.bootstrapSha256) ||
    admission.runtimeVersion !== "v24.20.0" ||
    admission.runtimePlatform !== "win32" ||
    admission.runtimeArch !== "x64" ||
    // The publisher (`host/scripts/production-artifact.mjs`), its tests, and the
    // production Desktop consumer (`InstalledHostRuntimeAdmission.cs`) all agree
    // on one shape: an object `{ schema, files[] }`. This gate is not a second
    // authority and must not invent a different one.
    !isRuntimeClosure(admission.runtimeClosure)
  )
    throw new Error("desktop_compose_runtime_admission_invalid");
  if (
    sha256(await readFile(runtimePath)) !== admission.runtimeSha256 ||
    sha256(await readFile(bootstrapPath)) !== admission.bootstrapSha256
  )
    throw new Error("desktop_compose_runtime_admission_mismatch");
  return Object.freeze({ artifactRoot, runtimePath, bootstrapPath });
}

/**
 * Installs the selected immutable generation into a fresh launcher-shaped root
 * (program/data/operational/presentation under the child's LOCALAPPDATA). The
 * full generation is copied so every module-relative seam (composition,
 * browser artifact, native helper pairs) resolves exactly like an installed
 * program generation; the reparse-inspector pair is additionally staged under
 * the entry directory where the bootstrap wire resolves it.
 */
export async function installDesktopCompositionGeneration({ artifactRoot, rootLayout }) {
  // The reason travels with the failure. A bare catch here reported every cause as "install failed", and that name cost a
  // debugging session: the real error was `ENOSPC` - the disk was full, the artifact had built fine - while the message
  // read like the install logic was broken. Each step names itself, and the errno is carried through, so the next reader
  // does not have to reproduce the copy by hand to find out what happened.
  const step = async (name, run) => {
    try {
      await run();
    } catch (error) {
      const code = error?.code ?? error?.errno ?? (error instanceof Error ? error.message : String(error));
      throw new Error(`desktop_compose_generation_install_failed:${name}:${String(code).slice(0, 120)}`);
    }
  };
  await step("roots", async () => {
    await mkdir(rootLayout.dataRoot, { recursive: true });
    await mkdir(rootLayout.operationalRoot, { recursive: true });
    await mkdir(rootLayout.presentationRoot, { recursive: true });
    await mkdir(dirname(rootLayout.generationRoot), { recursive: true });
  });
  await step("generation_copy", () => cp(artifactRoot, rootLayout.generationRoot, { recursive: true, force: true }));
  await step("reparse_pair_copy", () =>
    cp(
      join(artifactRoot, "native", "windows-reparse-inspector", "win-x64"),
      join(rootLayout.moduleDirectory, "native", "windows-reparse-inspector", "win-x64"),
      { recursive: true, force: true },
    ),
  );
  await regularDirectory(rootLayout.generationRoot, "installed_generation");
  return rootLayout;
}

function serveGuardianHello({ bootstrapId, generation, inventoryDigest, runtimeAdmissionSha256 }) {
  const endpoint = `\\\\.\\pipe\\GameBuddy.HostGuardian.${bootstrapId}`;
  const server = createServer();
  let session;
  let settled = false;
  const hello = new Promise((resolveHello, rejectHello) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        session?.destroy();
      } catch {
        /* already gone */
      }
      server.close(() => undefined);
      rejectHello(error);
    };
    const timer = setTimeout(
      () => fail(new Error("desktop_compose_guardian_hello_timeout")),
      GUARDIAN_HELLO_TIMEOUT_MS,
    );
    server.once("error", () => {
      clearTimeout(timer);
      fail(new Error("desktop_compose_guardian_pipe_unavailable"));
    });
    server.on("connection", (socket) => {
      if (session !== undefined || settled) {
        socket.destroy();
        return;
      }
      session = socket;
      let buffer = Buffer.alloc(0);
      const reject = () => fail(new Error("desktop_compose_guardian_hello_rejected"));
      socket.on("data", (chunk) => {
        if (settled) {
          // The one authenticated session carries no further protocol: any
          // non-hello frame (arm/launch/contain) must never be forged here.
          socket.destroy();
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(10);
        if (newline < 0) {
          if (buffer.length > MAX_GUARDIAN_FRAME_BYTES) reject();
          return;
        }
        if (newline !== buffer.length - 1 || buffer.includes(0) || buffer.includes(13)) return reject();
        let value;
        try {
          value = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        } catch {
          return reject();
        }
        if (!validateGuardianHelloRequest(value, { bootstrapId, generation, inventoryDigest, runtimeAdmissionSha256 }))
          return reject();
        clearTimeout(timer);
        settled = true;
        socket.write(
          `${JSON.stringify({ schema: GUARDIAN_SESSION_SCHEMA, protocolVersion: 1, operation: "hello", status: "accepted", bootstrapId, generation, inventoryDigest, runtimeAdmissionSha256 })}\n`,
          (error) => {
            if (error != null) {
              fail(new Error("desktop_compose_guardian_hello_rejected"));
              return;
            }
            resolveHello();
          },
        );
      });
      socket.on("error", () => {
        /* peer teardown is normal */
      });
      socket.on("close", () => {
        if (session === socket) session = undefined;
      });
    });
  });
  // The launcher may await the acknowledgement before the hello; keep the
  // promise rejection observable to awaiters without an unhandled rejection.
  void hello.catch(() => undefined);
  return Object.freeze({
    hello,
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(endpoint, () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      }),
    dispose: () => {
      if (settled && session === undefined) {
        server.close(() => undefined);
        return;
      }
      try {
        session?.destroy();
      } catch {
        /* already gone */
      }
      server.close(() => undefined);
    },
  });
}

function waitForBootstrapAck(child, timeoutMs, stderrTail = () => "", onStatus = undefined) {
  return new Promise((resolveAck, rejectAck) => {
    let data = "";
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      fn(value);
    };
    const onData = (chunk) => {
      data += chunk.toString("utf8");
      // Frames arrive one per line. Consume every complete line, skipping the status narration:
      // the first line that is not a status frame is the acknowledgement.
      for (;;) {
        const newline = data.indexOf("\n");
        if (newline < 0) return;
        const line = data.slice(0, newline);
        data = data.slice(newline + 1);
        if (line.trim().length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Not JSON at all: hand it to the caller's validator, which will refuse it with the
          // precise error rather than this launcher inventing one.
          settle(resolveAck, line);
          return;
        }
        if (parsed !== null && typeof parsed === "object" && parsed.schema === BOOTSTRAP_STATUS_SCHEMA) {
          if (typeof onStatus === "function") onStatus(parsed);
          continue;
        }
        settle(resolveAck, line);
        return;
      }
    };
    const onError = () => settle(rejectAck, new Error("desktop_compose_child_spawn_failed"));
    // The caller also captures a bounded stderr tail; use it so a pre-ack exit names
    // its product code here too, not just on the readiness waiter.
    const onExit = (code) => {
      const diagnostic = typeof stderrTail === "function" ? stderrTail() : "";
      settle(
        rejectAck,
        new Error(
          diagnostic.length > 0
            ? `dialogue_exited_before_ready:${code ?? "unknown"}:${diagnostic}`
            : `dialogue_exited_before_ready:${code ?? "unknown"}`,
        ),
      );
    };
    const timer = setTimeout(() => settle(rejectAck, new Error("dialogue_start_timeout")), timeoutMs);
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function collectChildMessages(child) {
  const subscriptions = new Set();
  const buffered = [];
  child.on("message", (value) => {
    buffered.push({ value, delivered: false });
    for (const listener of subscriptions) {
      try {
        listener(value);
      } catch {
        // Observer errors never kill the launcher.
      }
    }
  });
  return {
    subscribe(listener) {
      subscriptions.add(listener);
      for (const message of buffered) {
        if (message.delivered) continue;
        message.delivered = true;
        try {
          listener(message.value);
        } catch {
          // Observer errors never kill the launcher.
        }
      }
      return () => subscriptions.delete(listener);
    },
  };
}

/**
 * In the spawnImpl, the caller may observe the child's own outputs. A gate that
 * reports only `dialogue_exited_before_ready:<code>` cannot name why, so every
 * spawn carries a bounded stderr tail the readiness waiter appends to its
 * rejection. The child writes at most one bounded token (see
 * host/src/bootstrap/entry/desktop-host-entry.internal.ts) and never a stack.
 */
function waitForCompositionReady(child, timeoutMs, stderrTail = () => "") {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      fn(value);
    };
    const onMessage = (value) => {
      if (settled) return;
      if (validateCompositionReadyMessage(value)) settle(resolveReady, value.launchUrl);
    };
    const onError = () => settle(rejectReady, new Error("dialogue_spawn_failed"));
    const onExit = (code) => {
      // Preserve the child's bounded diagnostic so a pre-ready exit is
      // attributable rather than an opaque exit code.
      const diagnostic = typeof stderrTail === "function" ? stderrTail() : "";
      settle(
        rejectReady,
        new Error(
          diagnostic.length > 0
            ? `dialogue_exited_before_ready:${code ?? "unknown"}:${diagnostic}`
            : `dialogue_exited_before_ready:${code ?? "unknown"}`,
        ),
      );
    };
    const timer = setTimeout(() => settle(rejectReady, new Error("dialogue_start_timeout")), timeoutMs);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

/**
 * Launches the Desktop composition bootstrap for a gate fresh root and returns
 * the running child plus the validated bootstrap facts. The caller owns the
 * child's outputs and stop lifecycle; `dispose` closes the guardian pipe peer.
 */
export async function launchDesktopCompositionGateChild({
  outputRoot,
  root,
  surface = undefined,
  nonceSha256 = undefined,
  manifestPath,
  readyTimeoutMs = 60_000,
  spawnImpl = spawn,
  gameSessionMode = "fresh",
}) {
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot)) throw new Error("desktop_compose_output_root_invalid");
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("desktop_compose_root_invalid");
  if (!validateCompositionSurface(surface)) throw new Error("desktop_compose_surface_invalid");
  if (!validateCompositionNonceDigest(nonceSha256)) throw new Error("desktop_compose_nonce_invalid");
  const pointer = await readProductionPointer({ outputRoot });
  const admitted = await admitDesktopCompositionGeneration({ outputRoot, pointer });
  const rootLayout = createDesktopCompositionRootLayout(root, pointer.generation);
  await installDesktopCompositionGeneration({ artifactRoot: admitted.artifactRoot, rootLayout });
  const bootstrapId = randomBytes(32).toString("hex");
  const frame = composeDesktopBootstrapFrame({ bootstrapId, ...pointer, rootLayout });
  const peer = serveGuardianHello({ bootstrapId, ...pointer });
  await peer.listen();
  // The pipe server is listening from here on: every failure below must dispose it, or a launch that
  // did not complete leaves a live guardian endpoint behind.
  try {
    // Spawn the INSTALLED copy, not the artifact. The bootstrap validates that its
    // own module directory is inside `rootLayout.programRoot` (the child's
    // LOCALAPPDATA), which the artifact path never is once the generation is
    // published outside the repository — so spawning the artifact made every
    // installed/composed run die with `desktop_runtime_bootstrap_unavailable`. The
    // install step exists precisely to give the child its launcher-shaped root, and
    // the production Desktop launcher starts the installed generation too. Runtime
    // and bootstrap are therefore resolved relative to the installed root; their
    // artifact-side digests were already verified above by the admission.
    const installedRuntimePath = join(rootLayout.generationRoot, "runtime", "node.exe");
    const installedBootstrapPath = join(
      rootLayout.generationRoot,
      "bootstrap",
      "entry",
      "desktop-host-entry.internal.js",
    );
    await regularFile(installedRuntimePath, "installed_runtime");
    await regularFile(installedBootstrapPath, "installed_bootstrap");
    const child = spawnImpl(installedRuntimePath, [installedBootstrapPath], {
      cwd: rootLayout.generationRoot,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
      env: composeDesktopChildEnvironment({
        base: process.env,
        localAppDataRoot: root,
        manifestPath,
        surface,
        nonceSha256,
        gameSessionMode,
      }),
    });
    // The child may publish the IPC-ready fact and the gate markers while the
    // acknowledgement is still awaited; every message is buffered from spawn so
    // late subscribers (the gate collectors, the ready waiter) never miss one.
    const messages = collectChildMessages(child);
    // Capture a bounded stderr tail so a pre-ready exit names its cause. The
    // child writes at most one bounded token and never a stack; the printf-style
    // cap keeps a misbehaving child from growing this buffer without bound.
    let childStderr = "";
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      if (childStderr.length < 2_048) childStderr = `${childStderr}${chunk}`;
    });
    const readyPromise = waitForCompositionReady(child, readyTimeoutMs, () => childStderr.trim());
    // The callers await this only AFTER the bootstrap ack and the guardian hello. A
    // child that exits in that window would reject an unobserved promise and kill the
    // process with an unhandled rejection, discarding the bounded diagnostic it
    // carries and making every early failure look like a crash with no handler.
    // Attaching a no-op handler here does not consume the rejection: a later
    // `waitForReady()` still observes it.
    readyPromise.catch(() => undefined);
    // The ack waiter attaches before the frame write so an early wire failure is
    // never missed; the frame is the one bootstrap input, written once and
    // followed by EOF, exactly like the production launcher's private bootstrap pipe.
    const ackPromise = waitForBootstrapAck(child, readyTimeoutMs, () => childStderr.trim());
    child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
      if (error != null && child.listenerCount("error") > 0) child.emit("error", error);
    });
    child.stdin.end();
    const ackLine = await ackPromise;
    let ack;
    try {
      ack = JSON.parse(ackLine);
    } catch {
      throw new Error("desktop_compose_bootstrap_ack_invalid");
    }
    if (!validateBootstrapAcknowledgement(ack, { bootstrapId, ...pointer }))
      throw new Error("desktop_compose_bootstrap_ack_invalid");
    await peer.hello;
    return Object.freeze({
      child,
      bootstrapId,
      rootLayout,
      frame,
      ack,
      // The honest isolation subject travels with the launch: the child's real data root is the
      // deployment manifest's `runtimeRoot`, not the bootstrap frame's declared layout. A driver
      // that re-derives the narrow `GameBuddy\{data,operational,presentation}` check can report a
      // run that wrote tens of thousands of files as "the temp root is empty"; this measures both.
      measureRunRoots: async () =>
        measureDesktopCompositionRunRoots({
          root,
          runtimeRoot: await readDesktopCompositionRuntimeRoot({ manifestPath }),
        }),
      onMessage: (listener) => messages.subscribe(listener),
      waitForReady: () => readyPromise,
      dispose: () => peer.dispose(),
    });
  } catch (error) {
    peer.dispose();
    throw error;
  }
}
