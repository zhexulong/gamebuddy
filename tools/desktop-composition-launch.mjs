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
import { cp, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const BOOTSTRAP_SCHEMA = "gamebuddy-desktop-host-bootstrap/v1";
const GUARDIAN_SESSION_SCHEMA = "gamebuddy-desktop-guardian-session/v1";
const ROOT_LAYOUT_SCHEMA = "gamebuddy-windows-root-layout/v1";
const READY_SCHEMA = "gamebuddy-desktop-composition-ready/v1";
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

export function validateCompositionNonceDigest(value) {
  return value === undefined || hex64(value);
}

export function createDesktopCompositionRootLayout(localAppDataRoot, generation) {
  if (typeof localAppDataRoot !== "string" || localAppDataRoot.length === 0)
    throw new Error("desktop_compose_root_invalid");
  if (typeof generation !== "string" || !/^[a-z0-9-]+$/i.test(generation))
    throw new Error("desktop_compose_generation_invalid");
  return Object.freeze({
    programRoot: join(localAppDataRoot, "Programs", "GameBuddy"),
    dataRoot: join(localAppDataRoot, "GameBuddy", "data"),
    operationalRoot: join(localAppDataRoot, "GameBuddy", "operational"),
    presentationRoot: join(localAppDataRoot, "GameBuddy", "presentation"),
    generationRoot: join(localAppDataRoot, "Programs", "GameBuddy", generation),
    moduleDirectory: join(localAppDataRoot, "Programs", "GameBuddy", generation, "bootstrap", "entry"),
  });
}

export function composeDesktopBootstrapFrame({ bootstrapId, generation, inventoryDigest, runtimeAdmissionSha256, rootLayout }) {
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
    exactKeysInOrder(value, ["schema", "protocolVersion", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "rootLayoutSchema"]) &&
    value.schema === BOOTSTRAP_SCHEMA &&
    value.protocolVersion === 1 &&
    value.status === "accepted" &&
    value.bootstrapId === expected.bootstrapId &&
    value.generation === expected.generation &&
    value.inventoryDigest === expected.inventoryDigest &&
    value.runtimeAdmissionSha256 === expected.runtimeAdmissionSha256 &&
    value.rootLayoutSchema === ROOT_LAYOUT_SCHEMA
  );
}

export function validateGuardianHelloRequest(value, expected) {
  return (
    exactKeysInOrder(value, ["schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256"]) &&
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

export function composeDesktopChildEnvironment({ base, localAppDataRoot, manifestPath, surface = undefined, nonceSha256 = undefined }) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) throw new Error("desktop_compose_manifest_invalid");
  return Object.freeze({
    ...base,
    LOCALAPPDATA: localAppDataRoot,
    GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST: manifestPath,
    GAMEBUDDY_HOST_GAME_SESSION_MODE: "fresh",
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
    !exactKeysInOrder(admission, ["schema", "inventoryDigest", "generation", "runtimePath", "runtimeSha256", "bootstrapPath", "bootstrapSha256", "runtimeVersion", "runtimePlatform", "runtimeArch", "runtimeClosure"]) ||
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
    !Array.isArray(admission.runtimeClosure) ||
    admission.runtimeClosure.length === 0
  )
    throw new Error("desktop_compose_runtime_admission_invalid");
  if (sha256(await readFile(runtimePath)) !== admission.runtimeSha256 || sha256(await readFile(bootstrapPath)) !== admission.bootstrapSha256)
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
  try {
    await mkdir(rootLayout.dataRoot, { recursive: true });
    await mkdir(rootLayout.operationalRoot, { recursive: true });
    await mkdir(rootLayout.presentationRoot, { recursive: true });
    await mkdir(dirname(rootLayout.generationRoot), { recursive: true });
    await cp(artifactRoot, rootLayout.generationRoot, { recursive: true, force: true });
    await cp(
      join(artifactRoot, "native", "windows-reparse-inspector", "win-x64"),
      join(rootLayout.moduleDirectory, "native", "windows-reparse-inspector", "win-x64"),
      { recursive: true, force: true },
    );
  } catch {
    throw new Error("desktop_compose_generation_install_failed");
  }
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
      try { session?.destroy(); } catch { /* already gone */ }
      server.close(() => undefined);
      rejectHello(error);
    };
    const timer = setTimeout(() => fail(new Error("desktop_compose_guardian_hello_timeout")), GUARDIAN_HELLO_TIMEOUT_MS);
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
        if (!validateGuardianHelloRequest(value, { bootstrapId, generation, inventoryDigest, runtimeAdmissionSha256 })) return reject();
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
      socket.on("error", () => { /* peer teardown is normal */ });
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
      try { session?.destroy(); } catch { /* already gone */ }
      server.close(() => undefined);
    },
  });
}

function waitForBootstrapAck(child, timeoutMs) {
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
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      settle(resolveAck, data.slice(0, newline));
    };
    const onError = () => settle(rejectAck, new Error("desktop_compose_child_spawn_failed"));
    const onExit = (code) => settle(rejectAck, new Error(`dialogue_exited_before_ready:${code ?? "unknown"}`));
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

function waitForCompositionReady(child, timeoutMs) {
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
    const onExit = (code) => settle(rejectReady, new Error(`dialogue_exited_before_ready:${code ?? "unknown"}`));
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
  const child = spawnImpl(admitted.runtimePath, [admitted.bootstrapPath], {
    cwd: rootLayout.generationRoot,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
    env: composeDesktopChildEnvironment({
      base: process.env,
      localAppDataRoot: root,
      manifestPath,
      surface,
      nonceSha256,
    }),
  });
  // The child may publish the IPC-ready fact and the gate markers while the
  // acknowledgement is still awaited; every message is buffered from spawn so
  // late subscribers (the gate collectors, the ready waiter) never miss one.
  const messages = collectChildMessages(child);
  const readyPromise = waitForCompositionReady(child, readyTimeoutMs);
  // The ack waiter attaches before the frame write so an early wire failure is
  // never missed; the frame is the one bootstrap input, written once and
  // followed by EOF, exactly like the production launcher's private bootstrap pipe.
  const ackPromise = waitForBootstrapAck(child, readyTimeoutMs);
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
    onMessage: (listener) => messages.subscribe(listener),
    waitForReady: () => readyPromise,
    dispose: () => peer.dispose(),
  });
}