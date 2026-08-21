import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  CONTROL_PROTOCOL_VERSION,
  ControlProtocolError,
  type ControlRequest,
  ControlRequestFramer,
} from "./companion-control-protocol.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REMEMBERED_REQUESTS = 256;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

export type ProductControlLaunch = Readonly<{ pipeName: string; launchToken: string }>;
export type ProductControlTarget = Readonly<{
  acceptPlayerInput(input: Readonly<{ sourceEventId: string; text: string; locale: string }>): Promise<void>;
  stopAll(input: Readonly<{ stopId: string; sourceEventId: string; reasonCode: string }>): Readonly<{
    admission: Readonly<{ accepted: boolean }>;
    /** Present for the Host-owned Pi lifecycle implementation; absent only in legacy test doubles. */
    outcome?: "active_turn_cancelled" | "queued_turn_cancelled" | "no_active_turn";
    settled: Promise<void>;
  }>;
}>;
export type CompanionControlServer = Readonly<{ close(): Promise<void>; runtimeInstanceId: string }>;

/** Test-only process clock seam; production always uses the platform defaults. */
export type CompanionControlServerTestDependencies = Readonly<{
  platform: "win32";
  spawnHelper: () => ChildProcessWithoutNullStreams;
  requestTimeoutMs: number;
  /** Test-only per-frame scheduling seam; production uses platform timers. */
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => () => void;
}>;

type HelperFrame = Readonly<{ connectionId: string; line: string }>;
type CachedReply = Readonly<{ fingerprint: string; reply: string }>;
type RequestReservation = {
  fingerprint: string;
  settled: Promise<CachedReply>;
  resolve: (reply: CachedReply) => void;
};
type ServerWaiter = {
  done: Promise<boolean>;
  cancel: () => void;
};

/** Validates short-lived launcher-only values; neither is ever written or published. */
export function readProductControlLaunch(environment: NodeJS.ProcessEnv = process.env): ProductControlLaunch {
  const pipeName = environment.GAMEBUDDY_CONTROL_PIPE;
  const launchToken = environment.GAMEBUDDY_CONTROL_TOKEN;
  if (process.platform !== "win32") throw new Error("windows_product_control_required");
  if (typeof pipeName !== "string" || !IDENTIFIER.test(pipeName)) throw new Error("invalid_gamebuddy_control_pipe");
  if (typeof launchToken !== "string" || !TOKEN.test(launchToken)) throw new Error("invalid_gamebuddy_control_token");
  return Object.freeze({ pipeName, launchToken });
}

/** Starts only after the durable semantic lease has committed. The PowerShell helper owns DACL/SID verification and pipe I/O. */
export function startCompanionControlServer(
  launch: ProductControlLaunch,
  target: ProductControlTarget,
  testDependencies?: CompanionControlServerTestDependencies,
): CompanionControlServer {
  if ((testDependencies?.platform ?? process.platform) !== "win32") throw new Error("windows_product_control_required");
  if (!IDENTIFIER.test(launch.pipeName) || !TOKEN.test(launch.launchToken))
    throw new Error("invalid_product_control_launch");
  const asset = fileURLToPath(new URL("./windows-current-user-control-pipe.ps1", import.meta.url));
  // The helper authenticates local pipe clients itself; it must not inherit the
  // Host's launch credentials that authorize a client-to-Host hello.
  const { GAMEBUDDY_CONTROL_TOKEN: _token, GAMEBUDDY_CONTROL_PIPE: _pipe, ...helperEnvironment } = process.env;
  const child =
    testDependencies?.spawnHelper() ??
    spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        asset,
        "-PipeName",
        launch.pipeName,
      ],
      {
        stdio: "pipe",
        windowsHide: true,
        env: helperEnvironment,
      },
    );
  const runtimeInstanceId = randomUUID().replaceAll("-", "");
  let closed = false;
  let helperExited = false;
  let helperTerminationStarted = false;
  let failed: Error | undefined;
  let closePromise: Promise<void> | undefined;
  const replies = new Map<string, CachedReply>();
  const reservations = new Map<string, RequestReservation>();
  const authenticatedConnections = new Set<string>();
  // A launch token authorizes exactly one client connection for the complete
  // server lifetime. A rejected hello leaves it available; a successful hello
  // claims it before any reply can be observed.
  let launchTokenClaimed = false;
  const waiters = new Set<ServerWaiter>();
  const cancelWaiters = (): void => {
    for (const waiter of waiters) waiter.cancel();
  };
  const createWaiter = (timeoutMs: number, onTimeout: () => void): ServerWaiter => {
    let settled = false;
    let resolve!: (timedOut: boolean) => void;
    let cancelTimer: () => void = () => {};
    const waiter: ServerWaiter = {
      done: new Promise<boolean>((done) => {
        resolve = done;
      }),
      cancel: () => {
        if (settled) return;
        settled = true;
        cancelTimer();
        waiters.delete(waiter);
        resolve(false);
      },
    };
    const timeout = () => {
      if (settled) return;
      settled = true;
      waiters.delete(waiter);
      resolve(true);
      onTimeout();
    };
    cancelTimer =
      testDependencies?.scheduleTimeout?.(timeout, timeoutMs) ??
      (() => {
        const timer = setTimeout(timeout, timeoutMs);
        return () => clearTimeout(timer);
      })();
    waiters.add(waiter);
    return waiter;
  };
  const terminateHelper = (): void => {
    if (helperTerminationStarted) return;
    helperTerminationStarted = true;
    // stdin can synchronously reject writes/end after its peer has failed.
    // Never let cleanup turn a sealed server into an uncaught process error.
    try {
      child.stdin.end();
    } catch {
      /* already fail-closed */
    }
    try {
      child.kill();
    } catch {
      /* already fail-closed */
    }
  };
  const seal = (code: string): void => {
    if (failed !== undefined) return;
    failed = new Error(code);
    closed = true;
    cancelWaiters();
    terminateHelper();
  };
  // This listener is installed before any stdin operation and remains present
  // for the helper lifetime, so an asynchronous EPIPE cannot become an
  // unhandled EventEmitter error or replace the first failure reason.
  child.stdin.on("error", () => seal("product_control_helper_stdin_failed"));
  // ChildProcess can emit more than one error while termination races. Keep a
  // listener for its entire lifetime: the first live error seals, while later
  // errors are consumed without replacing the original failure or cleanup.
  child.on("error", () => seal("product_control_helper_exit"));
  child.once("exit", () => {
    helperExited = true;
    if (!closed) seal("product_control_helper_exit");
  });
  const write = (connectionId: string, reply: unknown): void => {
    if (closed || !IDENTIFIER.test(connectionId)) return;
    const line = JSON.stringify({ connectionId, reply });
    if (Buffer.byteLength(line, "utf8") > 16 * 1024) return seal("product_control_reply_oversize");
    try {
      child.stdin.write(`${line}\n`);
    } catch {
      seal("product_control_helper_stdin_failed");
    }
  };
  const handle = async (frame: HelperFrame): Promise<void> => {
    // ReadLine can flush a final unterminated line while stdout is ending.
    // The stdout boundary may already have sealed us, so never even parse or
    // schedule such a residual frame after closure.
    if (closed) return;
    const framer = new ControlRequestFramer();
    let request: ControlRequest;
    try {
      const parsed = framer.push(Buffer.from(`${frame.line}\n`, "utf8"));
      framer.finish();
      if (parsed.length !== 1) throw new ControlProtocolError("invalid_control_request");
      request = parsed[0]!;
    } catch {
      // The helper is the only transport boundary. A forwarded frame that is
      // not exactly one strict control request means that boundary is no
      // longer trustworthy; never send a protocol error back through it.
      seal("product_control_client_frame_invalid");
      return;
    }
    const fingerprint = canonicalControlRequestFingerprint(request);
    const requestId = request.type === "hello" ? undefined : request.requestId;
    if (requestId !== undefined) {
      const prior = replies.get(requestId);
      if (prior !== undefined) {
        write(
          frame.connectionId,
          prior.fingerprint === fingerprint
            ? JSON.parse(prior.reply)
            : { ok: false, code: "control_idempotency_collision" },
        );
        return;
      }
      const pending = reservations.get(requestId);
      if (pending !== undefined) {
        if (pending.fingerprint !== fingerprint) {
          write(frame.connectionId, { ok: false, code: "control_idempotency_collision" });
          return;
        }
        // A retry is a separate client wait, not a second target execution.
        // It receives its own bounded response deadline even when it arrives
        // before the original request's deadline. The reservation stays live
        // until the sole target invocation authoritatively settles.
        const reply = await awaitReservationReply(
          pending,
          testDependencies?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
          createWaiter,
        );
        if (reply !== null) write(frame.connectionId, JSON.parse(reply.reply));
        return;
      }
      if (replies.size + reservations.size >= MAX_REMEMBERED_REQUESTS) {
        write(frame.connectionId, { ok: false, code: "control_idempotency_capacity" });
        return;
      }
    }
    let replySent = false;
    let reservation: RequestReservation | undefined;
    if (requestId !== undefined) {
      let resolve!: (reply: CachedReply) => void;
      const pending = new Promise<CachedReply>((done) => {
        resolve = done;
      });
      reservation = { fingerprint, settled: pending, resolve };
      reservations.set(requestId, reservation);
    }
    const finishReservation = (reply: Record<string, unknown>): void => {
      if (requestId === undefined || reservation === undefined) return;
      const cached = Object.freeze({ fingerprint, reply: JSON.stringify(reply) });
      // Capacity was admitted before starting the target. A final result is
      // the only point that frees the live idempotency reservation.
      replies.set(requestId, cached);
      reservations.delete(requestId);
      reservation.resolve(cached);
    };
    const waiter = createWaiter(testDependencies?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, () => {
      if (replySent || closed) return;
      replySent = true;
      // This is only this frame's client-visible deadline. The reservation
      // remains live until its sole target invocation settles.
      write(frame.connectionId, { ok: false, code: "control_request_timeout" });
    });
    try {
      let reply!: Record<string, unknown>;
      if (request.type === "hello") {
        if (
          launchTokenClaimed ||
          authenticatedConnections.has(frame.connectionId) ||
          request.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
          !safeTokenEqual(request.launchToken, launch.launchToken)
        )
          throw new Error("control_hello_rejected");
        launchTokenClaimed = true;
        authenticatedConnections.add(frame.connectionId);
        reply = { ok: true, runtimeInstanceId, protocolVersion: CONTROL_PROTOCOL_VERSION };
      } else {
        if (!authenticatedConnections.has(frame.connectionId)) throw new Error("control_hello_required");
        if (request.runtimeInstanceId !== runtimeInstanceId) throw new Error("control_runtime_mismatch");
        if (request.type === "player_input") {
          // Do not cross the Host-to-target authority boundary after any
          // asynchronous transport seal, including stdout EOF residual lines.
          if (closed) return;
          await target.acceptPlayerInput({
            sourceEventId: request.sourceEventId,
            text: request.text,
            locale: request.locale,
          });
          reply = { ok: true, accepted: "player_input" };
        } else if (request.type === "stop_all") {
          // Keep this immediately adjacent to synchronous control admission:
          // target work starts before its settled promise exists.
          if (closed) return;
          const stopped = target.stopAll({
            stopId: request.stopId,
            sourceEventId: request.sourceEventId,
            reasonCode: "player_stop_all",
          });
          try {
            await stopped.settled;
          } catch {
            seal("product_control_stop_uncertain");
            throw new Error("control_stop_uncertain");
          }
          reply = {
            ok: true,
            accepted: !stopped.admission.accepted
              ? "duplicate_stop"
              : stopped.outcome === "active_turn_cancelled"
                ? "active_turn_cancelled"
                : stopped.outcome === "queued_turn_cancelled"
                  ? "queued_turn_cancelled"
                  : stopped.outcome === "no_active_turn"
                    ? "no_active_turn"
                    : "stop_all",
          };
        }
      }
      finishReservation(reply);
      if (!replySent) {
        replySent = true;
        write(frame.connectionId, reply);
      }
    } catch (error) {
      const reply = { ok: false, code: error instanceof Error ? error.message : "control_request_failed" };
      finishReservation(reply);
      if (!replySent) {
        replySent = true;
        write(frame.connectionId, reply);
      }
    } finally {
      waiter.cancel();
    }
  };
  // Install output failure listeners before ReadLine so no error/end/close
  // window can leave a live helper without a usable Host control channel.
  // A deliberate close sets `closed` first; an exit caused by fail-closed
  // termination does the same, so these signals cannot duplicate cleanup.
  const stdoutUnavailable = (): void => {
    if (!closed && !helperExited) seal("product_control_helper_stdout_failed");
  };
  child.stdout.once("end", stdoutUnavailable);
  child.stdout.once("close", stdoutUnavailable);
  // Keep an error listener for the entire helper lifetime: streams can emit
  // more than one error while teardown races, and none may escape uncaught.
  child.stdout.on("error", stdoutUnavailable);
  const readline = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  // ReadLine forwards input errors to its own EventEmitter. It is not enough
  // to observe stdout directly: without this persistent listener a forwarded
  // error would throw synchronously as an unhandled ReadLine error.
  readline.on("error", stdoutUnavailable);
  readline.once("close", stdoutUnavailable);
  readline.on("line", (line) => {
    // A final unterminated line can be synchronously flushed by ReadLine from
    // its input end listener. stdoutUnavailable is registered first, so EOF
    // seals before that flush; reject the residual at the transport boundary.
    if (closed) return;
    try {
      const frame = JSON.parse(line) as HelperFrame;
      if (
        !frame ||
        !IDENTIFIER.test(frame.connectionId) ||
        typeof frame.line !== "string" ||
        Buffer.byteLength(frame.line, "utf8") > 16 * 1024
      )
        throw new Error();
      void handle(frame);
    } catch {
      seal("product_control_helper_frame_invalid");
    }
  });
  return Object.freeze({
    runtimeInstanceId,
    close: async () => {
      if (closePromise !== undefined) return closePromise;
      if (helperExited) return Promise.resolve();
      closePromise = new Promise<void>((resolve) => {
        closed = true;
        cancelWaiters();
        let fallback: ReturnType<typeof setTimeout>;
        const finish = (): void => {
          clearTimeout(fallback);
          resolve();
        };
        fallback = setTimeout(finish, 1_000);
        fallback.unref();
        child.once("exit", finish);
        terminateHelper();
      });
      return closePromise;
    },
  });
}

async function awaitReservationReply(
  reservation: RequestReservation,
  timeoutMs: number,
  createWaiter: (timeoutMs: number, onTimeout: () => void) => ServerWaiter,
): Promise<CachedReply | null> {
  let timeoutReply: CachedReply | undefined;
  const waiter = createWaiter(timeoutMs, () => {
    timeoutReply = Object.freeze({
      fingerprint: reservation.fingerprint,
      reply: JSON.stringify({ ok: false, code: "control_request_timeout" }),
    });
  });
  try {
    const result = await Promise.race([
      reservation.settled.then((reply) => ({ kind: "settled" as const, reply })),
      waiter.done.then((timedOut) => ({ kind: "waiter" as const, timedOut })),
    ]);
    if (result.kind === "settled") return result.reply;
    return result.timedOut ? timeoutReply! : null;
  } finally {
    waiter.cancel();
  }
}

/**
 * Stable semantic identity for validated protocol values. This deliberately
 * never fingerprints the transport JSON: whitespace, object ordering, and
 * equivalent JSON escape spellings are erased by protocol validation, while
 * every variant field (including optional-field presence) remains material.
 */
function canonicalControlRequestFingerprint(request: ControlRequest): string {
  switch (request.type) {
    case "hello":
      return JSON.stringify(["hello", request.protocolVersion, request.launchToken]);
    case "player_input":
      return JSON.stringify([
        "player_input",
        request.requestId,
        request.runtimeInstanceId,
        request.sourceEventId,
        request.text,
        request.locale,
      ]);
    case "stop_all":
      return JSON.stringify([
        "stop_all",
        request.requestId,
        request.runtimeInstanceId,
        request.stopId,
        request.sourceEventId,
      ]);
  }
}

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
