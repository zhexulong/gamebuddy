import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";
import { inspectLegacyAuthoritySealCandidate } from "./legacy-authority-seal.js";

type Reply = { ok: boolean; code: string; message?: string };
type WireReply = Reply & { protocol: "gamebuddy.windows-legacy-authority-seal/v1"; nonce: string; pid?: number };
type WriterOptions = { protocolNoise?: string };

const powershell = "powershell.exe";
const protocol = "gamebuddy.windows-legacy-authority-seal/v1" as const;
// The PowerShell fixture is emitted beside this compiled test. Resolve it from
// this module rather than the caller's working directory.
const fixture = fileURLToPath(new URL("./legacy-writer-fixture.ps1", import.meta.url));

const invalidPipeFrame = "legacy writer protocol error: invalid pipe frame";
const maxDiagnosticBytes = 4096;

function protocolError(): Error {
  // Pipe input is untrusted. Do not reflect it into the assertion surface or
  // accidentally make arbitrary data a second protocol.
  return new Error(invalidPipeFrame);
}

function parseReply(line: string, nonce: string): Reply {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw protocolError();
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Partial<WireReply>).protocol !== protocol ||
    (value as Partial<WireReply>).nonce !== nonce ||
    typeof (value as Partial<WireReply>).ok !== "boolean" ||
    typeof (value as Partial<WireReply>).code !== "string" ||
    ("message" in value && typeof (value as Partial<WireReply>).message !== "string")
  )
    throw protocolError();
  const { ok, code, message } = value as WireReply;
  return message === undefined ? { ok, code } : { ok, code, message };
}

async function listen(server: Server, path: string): Promise<void> {
  server.listen(path);
  await once(server, "listening");
}

async function writer(
  root: string,
  options: WriterOptions = {},
): Promise<{ request(op: string): Promise<Reply>; close(): Promise<void> }> {
  const pipeName = `gamebuddy-legacy-seal-${process.pid}-${randomUUID()}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const nonce = randomUUID();
  let socketResolve: ((socket: Socket) => void) | undefined;
  let socketReject: ((error: Error) => void) | undefined;
  const socketReady = new Promise<Socket>((resolve, reject) => {
    socketResolve = resolve;
    socketReject = reject;
  });
  // A random pipe name is not authentication. Admit one transport connection,
  // then require the nonce-bound ready frame before accepting any reply.
  const server = createServer((socket) => {
    if (!socketResolve) {
      socket.destroy();
      return;
    }
    const resolve = socketResolve;
    socketResolve = undefined;
    resolve(socket);
  });
  const serverClosed = new Promise<void>((resolve) => server.once("close", resolve));
  await listen(server, pipePath);
  const child = spawn(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fixture,
      "-Root",
      root,
      "-PipeName",
      pipeName,
      "-Nonce",
      nonce,
      ...(options.protocolNoise === undefined ? [] : ["-ProtocolNoise", options.protocolNoise]),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let childClosed = false;
  const childReaped = new Promise<void>((resolve) =>
    child.once("close", () => {
      childClosed = true;
      resolve();
    }),
  );
  let socket: Socket | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let closePromise: Promise<void> | undefined;
  const replies: Reply[] = [];
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  let protocolReady = false;
  let disposing = false;
  let stderr = "";
  const appendDiagnostic = (chunk: Buffer) => {
    if (stderr.length >= maxDiagnosticBytes) return;
    stderr += chunk.toString("utf8").slice(0, maxDiagnosticBytes - stderr.length);
  };
  const childExitDiagnostic = () => (stderr.length === 0 ? "" : `; stderr=${JSON.stringify(stderr)}`);
  const fail = (error: Error) => {
    if (!failure) {
      failure = error;
      socketReject?.(error);
      wake?.();
      wake = undefined;
    }
  };
  server.once("error", (error) =>
    fail(new Error(`legacy writer protocol error: pipe server failed: ${error.message}`)),
  );
  child.once("error", (error) => fail(new Error(`legacy writer protocol error: child failed: ${error.message}`)));
  child.once("exit", (code, signal) => {
    if (!disposing && !failure && !replies.length)
      fail(
        new Error(
          `legacy writer protocol error: child exited before reply (code=${code}, signal=${signal})${childExitDiagnostic()}`,
        ),
      );
  });
  child.stdout!.on("data", (chunk) => {
    if (!disposing && protocolReady)
      fail(
        new Error(
          `legacy writer protocol error: unexpected stdout after readiness ${JSON.stringify(chunk.toString())}`,
        ),
      );
  });
  // Stderr is bounded diagnostic evidence only. It is never parsed or used as
  // protocol input, including when the child fails before the pipe ready frame.
  child.stderr!.on("data", appendDiagnostic);
  async function dispose(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      disposing = true;
      lines?.close();
      socket?.destroy();
      if (server.listening) server.close();
      if (!childClosed && !child.killed) child.kill();
      await childReaped;
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (server.listening) server.close();
      await serverClosed;
    })();
    return closePromise;
  }
  try {
    socket = await socketReady;
    // Configure the connected transport before removing the listener. Closing
    // the listener only stops a second client; it must not negotiate or tear
    // down the already-connected pipe socket.
    lines = createInterface({ input: socket, crlfDelay: Infinity });
    server.close();
    socket.once("error", (error) => fail(new Error(`legacy writer protocol error: pipe failed: ${error.message}`)));
    lines.on("close", () => {
      if (!failure && !childClosed) fail(new Error("legacy writer protocol error: pipe closed before writer exited"));
    });
    lines.on("line", (line) => {
      try {
        const reply = parseReply(line, nonce);
        if (!protocolReady && reply.code !== "ready") throw protocolError();
        protocolReady = protocolReady || reply.code === "ready";
        replies.push(reply);
        wake?.();
        wake = undefined;
      } catch (error) {
        fail(error instanceof Error ? error : protocolError());
      }
    });
    async function next(): Promise<Reply> {
      while (!replies.length) {
        if (failure) throw failure;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure) throw failure;
      return replies.shift()!;
    }
    assert.equal((await next()).code, "ready");
    return {
      async request(op) {
        if (failure) throw failure;
        socket!.write(`${JSON.stringify({ op })}\n`);
        return next();
      },
      close: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function expectOk(instance: Awaited<ReturnType<typeof writer>>, op: string): Promise<void> {
  assert.deepEqual(await instance.request(op), { ok: true, code: "ok" });
}

async function expectFreshWriteDenied(instance: Awaited<ReturnType<typeof writer>>): Promise<void> {
  const reply = await instance.request("create");
  assert.equal(reply.ok, false, `controlled deny DACL unexpectedly permitted fresh write: ${JSON.stringify(reply)}`);
}

test(
  "SPIKE BLOCKER: writer protocol rejects non-protocol and JSON-shaped pipe noise rather than fixture replies",
  { skip: process.platform !== "win32" },
  async () => {
    for (const noise of ["Windows PowerShell", '{"ok":true,"code":"ready"}']) {
      const root = await mkdtemp(join(tmpdir(), "gamebuddy-legacy-seal-"));
      try {
        await assert.rejects(
          writer(root, { protocolNoise: noise }),
          (error) => error instanceof Error && error.message === invalidPipeFrame,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "SPIKE BLOCKER: post-DACL-mutation held handle remains writable and same user restores controlled DACL",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gamebuddy-legacy-seal-"));
    const old = await writer(root);
    try {
      await expectOk(old, "openHeld");
      await expectOk(old, "denyControlledWrite");
      await expectOk(old, "writeHeld");
      await expectFreshWriteDenied(old);
      await expectOk(old, "restoreControlledAllow");
      await expectOk(old, "create");
    } finally {
      await expectOk(old, "restoreOriginalAcl");
      assert.deepEqual(await old.request("close"), { ok: true, code: "closed" });
      await old.close();
      await rm(join(root, "held.txt"), { force: true, maxRetries: 20, retryDelay: 100 });
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "SPIKE BLOCKER: candidate inspection refuses a seal claim with independent writer and held handle",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gamebuddy-legacy-seal-"));
    const old = await writer(root);
    try {
      await expectOk(old, "openHeld");
      const inspection = await inspectLegacyAuthoritySealCandidate(root);
      assert.equal(inspection.claimed, false);
      assert.match(inspection.reason, /no_writer_proof/);
      await expectOk(old, "writeHeld");
    } finally {
      await expectOk(old, "restoreOriginalAcl");
      assert.deepEqual(await old.request("close"), { ok: true, code: "closed" });
      await old.close();
      await rm(join(root, "held.txt"), { force: true, maxRetries: 20, retryDelay: 100 });
      await rm(root, { recursive: true, force: true });
    }
  },
);
