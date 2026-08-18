import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  WindowsNamedMutexBroker,
  WindowsNamedMutexBrokerError,
  WindowsNamedMutexLease,
  windowsNamedMutexName,
} from "./windows-named-mutex-broker.js";

const unique = () => `test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const timeout = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null)
    await Promise.race([
      once(child, "exit").then(() => undefined),
      timeout(5_000).then(() => {
        throw new Error("child_exit_timeout");
      }),
    ]);
}
async function retainedAbandon(name: string): Promise<ChildProcess> {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(process.cwd(), "dist-test", "test-fixtures", "windows-named-mutex-retained-abandon.ps1"),
      "-Name",
      name,
    ],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  await Promise.race([
    once(lines, "line").then(([line]) => assert.equal(line, "ready")),
    timeout(5_000).then(() => {
      throw new Error("retained_abandon_ready_timeout");
    }),
  ]);
  return child;
}

test("named mutex API rejects non-Windows hosts and unsafe names", async () => {
  assert.throws(() => windowsNamedMutexName("../escape"), /invalid_windows_named_mutex_name/);
  if (process.platform !== "win32") {
    const broker = new WindowsNamedMutexBroker();
    await assert.rejects(broker.acquire(windowsNamedMutexName("safe")), /windows_named_mutex_required/);
    await broker.close();
  }
});

test("acquired mutex remains held until explicit release", { skip: process.platform !== "win32" }, async () => {
  const holder = new WindowsNamedMutexBroker();
  const contender = new WindowsNamedMutexBroker();
  const name = windowsNamedMutexName(unique());
  try {
    const lease = await holder.acquire(name);
    await assert.rejects(contender.acquire(name, { timeoutMs: 50 }), /windows_named_mutex_timeout/);
    await lease.release();
    await (await contender.acquire(name)).release();
  } finally {
    await contender.close();
    await holder.close();
  }
});

test(
  "sibling active lease blocks safety seal and remains releasable",
  { skip: process.platform !== "win32" },
  async () => {
    const broker = new WindowsNamedMutexBroker();
    const abandonedName = windowsNamedMutexName(unique());
    const siblingName = windowsNamedMutexName(unique());
    const retained = await retainedAbandon(abandonedName);
    try {
      const abandoned = await broker.acquire(abandonedName);
      assert.equal(abandoned.disposition, "abandoned");
      const sibling = await broker.acquire(siblingName);
      await assert.rejects(
        abandoned.safetySealAfterAbandonedQuarantineFailure(),
        /windows_named_mutex_safety_seal_rejected/,
      );
      await sibling.release();
      await abandoned.release();
    } finally {
      retained.stdin!.end();
      await reap(retained);
      await broker.close();
    }
  },
);

test(
  "sibling pending blocks safety seal and cancellation completes normally",
  { skip: process.platform !== "win32" },
  async () => {
    const broker = new WindowsNamedMutexBroker();
    const abandonedName = windowsNamedMutexName(unique());
    const pendingName = windowsNamedMutexName(unique());
    const retained = await retainedAbandon(abandonedName);
    const owner = new WindowsNamedMutexBroker();
    try {
      const abandoned = await broker.acquire(abandonedName);
      assert.equal(abandoned.disposition, "abandoned");
      const held = await owner.acquire(pendingName);
      const abort = new AbortController();
      const pending = broker.acquire(pendingName, { timeoutMs: 5_000, signal: abort.signal });
      await timeout(50);
      await assert.rejects(
        abandoned.safetySealAfterAbandonedQuarantineFailure(),
        /windows_named_mutex_safety_seal_rejected/,
      );
      abort.abort();
      await assert.rejects(pending, /windows_named_mutex_cancelled/);
      await held.release();
      await abandoned.release();
    } finally {
      retained.stdin!.end();
      await reap(retained);
      await owner.close();
      await broker.close();
    }
  },
);

test(
  "test-only seal worker retains abandoned sidecar until independent contender proof and parent release",
  { skip: process.platform !== "win32" },
  async () => {
    assert.ok(
      existsSync(join(process.cwd(), "dist-test", "windows-named-mutex-broker.ps1")),
      "tests must use the dist-test-only copied broker asset",
    );
    assert.equal(
      existsSync(join(process.cwd(), "dist", "test-fixtures", "windows-named-mutex-safety-seal-worker.js")),
      false,
      "production artifact must not contain test worker",
    );
    const name = windowsNamedMutexName(unique());
    const retained = await retainedAbandon(name);
    const worker = fork(
      join(process.cwd(), "dist-test", "test-fixtures", "windows-named-mutex-safety-seal-worker.js"),
      [name],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      const message = await Promise.race([
        once(worker, "message").then(([value]) => value as { type: string; name?: string; error?: string }),
        timeout(5_000).then(() => {
          throw new Error("seal_worker_timeout");
        }),
      ]);
      assert.deepEqual(message, { type: "sealed", name });
      const contender = new WindowsNamedMutexBroker();
      try {
        const next = await contender.acquire(name, { timeoutMs: 1_000 });
        assert.equal(next.disposition, "abandoned");
        await next.release();
      } finally {
        await contender.close();
      }
      worker.send("exit");
      await Promise.race([
        once(worker, "exit").then(() => undefined),
        timeout(5_000).then(() => {
          throw new Error("seal_worker_exit_timeout");
        }),
      ]);
    } finally {
      if (worker.exitCode === null) {
        worker.send("exit");
        await reap(worker);
      }
      retained.stdin!.end();
      await reap(retained);
    }
  },
);

test("child exit containment before an abandoned safety seal rejects without dispatching or registering", async () => {
  // Exact ordering: a held lease observes sidecar exit, fail() enters
  // containment, and only then its emergency seal transition is attempted.
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      stdin: { write(data: string, encoding: BufferEncoding, callback: (error?: Error) => void): boolean };
      kill(): boolean;
    };
    leases: Set<WindowsNamedMutexLease>;
    pending: Map<string, object>;
    safetySealed: boolean;
    fail(error: Error): void;
    beginReap(): void;
    close(): Promise<void>;
  };
  const name = windowsNamedMutexName("safety-seal-after-contained-exit");
  let writes = 0;
  let releases = 0;
  let reaps = 0;
  let kills = 0;
  broker.child = {
    exitCode: null,
    signalCode: null,
    stdin: {
      write: () => {
        writes += 1;
        return true;
      },
    },
    kill: () => {
      kills += 1;
      return true;
    },
  };
  broker.beginReap = () => {
    reaps += 1;
  };
  let lease!: WindowsNamedMutexLease;
  lease = new WindowsNamedMutexLease(
    name,
    "abandoned",
    async () => {
      releases += 1;
    },
    async () => {
      await (
        broker as unknown as { safetySealLease(lease: WindowsNamedMutexLease, targetId: string): Promise<void> }
      ).safetySealLease(lease, "acquire");
    },
  );
  broker.leases.add(lease);

  broker.child.exitCode = 1;
  broker.fail(new Error("sidecar_exit"));
  await assert.rejects(lease.safetySealAfterAbandonedQuarantineFailure(), /windows_named_mutex_safety_seal_failed/);

  assert.equal(broker.safetySealed, true, "the locally initiated transition remains terminally safety sealed");
  assert.equal(broker.pending.size, 0, "no impossible safety-seal acknowledgement is registered");
  assert.equal(writes, 0, "an exited or contained sidecar receives no safety-seal dispatch");
  assert.equal(releases, 0, "safety sealing must not fall back to normal release");
  assert.equal(reaps, 0, "containment must not enter normal reaping");
  assert.equal(kills, 0, "containment must not kill the sidecar");
  await assert.rejects(lease.release(), /windows_named_mutex_safety_sealed/);
  await assert.rejects(broker.close(), /windows_named_mutex_broker_safety_sealed/);
});

test("broker reap failure is terminal and does not repeat cleanup", async () => {
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: { exitCode: number | null; signalCode: NodeJS.Signals | null; stdin: { end(): void }; kill(): boolean };
    leases: Set<WindowsNamedMutexLease>;
    beginReap(): void;
    close(): Promise<void>;
  };
  let reaps = 0;
  broker.child = { exitCode: null, signalCode: null, stdin: { end() {} }, kill: () => true };
  broker.beginReap = () => {
    reaps += 1;
    (broker as unknown as { failed: Error }).failed = new Error("windows_named_mutex_broker_close_failed");
    (broker as unknown as { reapPromise: Promise<void> }).reapPromise = Promise.resolve();
  };
  const first = broker.close();
  await assert.rejects(first, /windows_named_mutex_broker_close_failed/);
  await assert.rejects(broker.close(), /windows_named_mutex_broker_close_failed/);
  assert.equal(reaps, 1);
  assert.equal((broker as unknown as { closed: boolean }).closed, false);
});

test("sidecar exit before reap checkpoint is terminal and cannot report a closed broker", async () => {
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: { exitCode: number | null; signalCode: NodeJS.Signals | null; stdin: { end(): void } };
    closing: boolean;
    failed?: Error;
    close(): Promise<void>;
    fail(error: Error): void;
  };
  broker.child = { exitCode: 1, signalCode: null, stdin: { end() {} } };
  broker.closing = true;
  broker.fail(new Error("windows_named_mutex_broker_exit"));
  await assert.rejects(broker.close(), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).name, "WindowsNamedMutexBrokerError");
    assert.equal((error as Error).message, "windows_named_mutex_broker_exit");
    return true;
  });
  assert.equal((broker as unknown as { closed: boolean }).closed, false);
  await assert.rejects(broker.close(), /windows_named_mutex_broker_exit/);
});

test("close-drain sidecar exit with pending protocol work is terminal", async () => {
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: { exitCode: number | null; signalCode: NodeJS.Signals | null; stdin: { end(): void } };
    closing: boolean;
    reapStarted: boolean;
    stdinEnded: boolean;
    pending: Map<string, object>;
    failed?: Error;
    close(): Promise<void>;
    fail(error: Error): void;
  };
  broker.child = { exitCode: 1, signalCode: null, stdin: { end() {} } };
  broker.closing = true;
  broker.reapStarted = true;
  broker.stdinEnded = true;
  broker.pending.set("pending", { reject: () => undefined });
  broker.fail(new Error("windows_named_mutex_broker_exit"));
  await assert.rejects(broker.close(), /windows_named_mutex_broker_exit/);
  assert.equal((broker as unknown as { closed: boolean }).closed, false);
  assert.ok(broker.failed);
});

test("first protocol terminal error survives a later reap timeout and repeated close", async () => {
  const stdin = new EventEmitter() as EventEmitter & { end(): void };
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      stdin: typeof stdin;
      kill(): boolean;
    };
    waitForExit(child: object, timeoutMs: number): Promise<boolean>;
    handleLine(line: string): void;
    close(): Promise<void>;
    failed?: WindowsNamedMutexBrokerError;
  };
  let waits = 0;
  broker.child = {
    exitCode: null,
    signalCode: null,
    stdin: Object.assign(stdin, { end() {} }),
    kill: () => true,
  };
  broker.waitForExit = async () => {
    waits += 1;
    if (waits === 1) queueMicrotask(() => broker.handleLine("not-json"));
    return false;
  };
  const first = broker.close();
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof WindowsNamedMutexBrokerError);
    assert.equal(error.code, "windows_named_mutex_protocol_error");
    return true;
  });
  assert.equal(waits, 2, "reap still reaches both wait/kill checkpoints");
  assert.equal((broker as unknown as { closed: boolean }).closed, false);
  assert.strictEqual(first, broker.close(), "repeat close returns the memoized terminal result");
  assert.equal(broker.failed?.code, "windows_named_mutex_protocol_error");
});

test("child error after stdin end during reap is terminal rather than an expected exit", async () => {
  const stdin = new EventEmitter() as EventEmitter & { end(): void };
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: Object.assign(stdin, { end() {} }),
    kill: () => true,
  });
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: typeof child;
    attachChildTerminalListeners(child: object): void;
    waitForExit(child: object, timeoutMs: number): Promise<boolean>;
    close(): Promise<void>;
    failed?: WindowsNamedMutexBrokerError;
  };
  let resolveWait!: (value: boolean) => void;
  let waits = 0;
  broker.child = child;
  broker.attachChildTerminalListeners(child);
  broker.waitForExit = async () => {
    waits += 1;
    return new Promise<boolean>((resolve) => {
      resolveWait = resolve;
    });
  };

  const first = broker.close();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  child.emit("error", new Error("child_error_after_stdin_end"));
  resolveWait(true);
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof WindowsNamedMutexBrokerError);
    assert.equal(error.code, "windows_named_mutex_broker_exit");
    return true;
  });
  assert.equal(waits, 1);
  assert.equal((broker as unknown as { closed: boolean }).closed, false);
  assert.strictEqual(first, broker.close(), "child error failure is memoized without a second reap");
  assert.equal(broker.failed?.code, "windows_named_mutex_broker_exit");
});

test("late stdin error after reap is consumed without revising successful close", async () => {
  const stdin = new EventEmitter() as EventEmitter & { end(): void };
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      stdin: typeof stdin;
      kill(): boolean;
    };
    waitForExit(child: object, timeoutMs: number): Promise<boolean>;
    close(): Promise<void>;
  };
  let ends = 0;
  let kills = 0;
  let waits = 0;
  broker.child = {
    exitCode: null,
    signalCode: null,
    stdin: Object.assign(stdin, {
      end: () => {
        ends += 1;
      },
    }),
    kill: () => {
      kills += 1;
      return true;
    },
  };
  broker.waitForExit = async () => {
    waits += 1;
    return true;
  };

  const first = broker.close();
  await first;
  assert.equal(stdin.listenerCount("error"), 1, "late pipe errors remain consumed until stream close");
  assert.doesNotThrow(() => stdin.emit("error", new Error("late_stdin_error")));
  await broker.close();
  assert.equal(ends, 1);
  assert.equal(kills, 0);
  assert.equal(waits, 1);
  assert.equal((broker as unknown as { closed: boolean }).closed, true);
});

test("asynchronous stdin.end error is typed, contained, and does not repeat cleanup", async () => {
  const stdin = new EventEmitter() as EventEmitter & { end(): void };
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      stdin: typeof stdin;
      kill(): boolean;
    };
    waitForExit(child: object, timeoutMs: number): Promise<boolean>;
    close(): Promise<void>;
  };
  let ends = 0;
  let kills = 0;
  let waits = 0;
  broker.child = {
    exitCode: null,
    signalCode: null,
    stdin: Object.assign(stdin, {
      end() {
        ends += 1;
        queueMicrotask(() => stdin.emit("error", new Error("async_stdin_end")));
      },
    }),
    kill: () => {
      kills += 1;
      return true;
    },
  };
  broker.waitForExit = async () => {
    waits += 1;
    return false;
  };
  const first = broker.close();
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof WindowsNamedMutexBrokerError);
    assert.equal(error.code, "windows_named_mutex_broker_close_failed");
    return true;
  });
  assert.equal(ends, 1);
  assert.equal(kills, 1);
  assert.equal(waits, 2);
  assert.equal((broker as unknown as { closed: boolean }).closed, false);
  assert.strictEqual(first, broker.close(), "repeat close does not re-run cleanup");
  assert.equal(ends, 1);
  assert.equal(kills, 1);
  assert.equal(waits, 2);
});

test("stdin.end, kill, and reap-body exceptions normalize to one terminal broker error", async () => {
  const cases = [
    {
      name: "stdin.end",
      child: {
        exitCode: null,
        signalCode: null,
        stdin: {
          end: () => {
            throw new Error("stdin_end_throw");
          },
        },
        kill: () => true,
      },
    },
    {
      name: "kill",
      child: {
        exitCode: null,
        signalCode: null,
        stdin: { end: () => undefined },
        kill: () => {
          throw new Error("kill_throw");
        },
      },
    },
    {
      name: "reap-body",
      child: { exitCode: null, signalCode: null, stdin: { end: () => undefined }, kill: () => true },
    },
  ] as const;
  for (const failure of cases) {
    const broker = new WindowsNamedMutexBroker() as unknown as {
      child?: typeof failure.child;
      waitForExit(child: object, timeoutMs: number): Promise<boolean>;
      close(): Promise<void>;
    };
    broker.child = failure.child;
    if (failure.name === "reap-body") {
      broker.waitForExit = async () => {
        throw new Error("wait_for_exit_throw");
      };
    } else if (failure.name === "kill") {
      broker.waitForExit = async () => false;
    }
    const first = broker.close();
    await assert.rejects(first, (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).name, "WindowsNamedMutexBrokerError", failure.name);
      assert.equal((error as Error).message, "windows_named_mutex_broker_close_failed", failure.name);
      return true;
    });
    assert.strictEqual(first, broker.close());
    assert.equal((broker as unknown as { closed: boolean }).closed, false, failure.name);
  }
});

test("safety seal failures, including synchronous stdin write throws, settle pending containment without normal cleanup", async () => {
  for (const failure of ["write", "sync_write", "child", "malformed"] as const) {
    const broker = new WindowsNamedMutexBroker() as unknown as {
      child?: { stdin: { write(data: string, encoding: BufferEncoding, callback: (error?: Error) => void): boolean } };
      leases: Set<WindowsNamedMutexLease>;
      beginReap(): void;
      fail(error: Error): void;
      handleLine(line: string): void;
      close(): Promise<void>;
      safetySealed: boolean;
      pending: Map<string, object>;
    };
    const name = windowsNamedMutexName(`safety-seal-${failure}`);
    let writes = 0;
    let reaps = 0;
    broker.child = {
      stdin: {
        write: (_data, _encoding, callback) => {
          writes += 1;
          if (failure === "sync_write") throw new Error("write_threw_synchronously");
          if (failure === "write") callback(new Error("write_failed"));
          return true;
        },
      },
    };
    broker.beginReap = () => {
      reaps += 1;
    };
    let lease!: WindowsNamedMutexLease;
    lease = new WindowsNamedMutexLease(
      name,
      "abandoned",
      async () => {
        throw new Error("normal_release_must_not_run");
      },
      async () => {
        await (
          broker as unknown as { safetySealLease(lease: WindowsNamedMutexLease, targetId: string): Promise<void> }
        ).safetySealLease(lease, "acquire");
      },
    );
    broker.leases.add(lease);
    const sealing = lease.safetySealAfterAbandonedQuarantineFailure();
    if (failure === "child") broker.fail(new Error("sidecar_exit"));
    if (failure === "malformed") broker.handleLine("not-json");
    await assert.rejects(sealing, /windows_named_mutex_safety_seal_failed/);
    await assert.rejects(lease.safetySealAfterAbandonedQuarantineFailure(), /windows_named_mutex_safety_seal_rejected/);
    assert.equal(broker.safetySealed, true, `${failure} leaves the broker safety sealed`);
    assert.equal(broker.pending.size, 0, `${failure} settles the safety-seal pending request`);
    await assert.rejects(lease.release(), /windows_named_mutex_safety_sealed/);
    await assert.rejects(broker.close(), /windows_named_mutex_broker_safety_sealed/);
    assert.equal(writes, 1, `${failure} must not send a normal release or retry seal`);
    assert.equal(reaps, 0, `${failure} must not reap or kill the sidecar`);
  }
});

test("cancel held then rejected release enters containment and close neither retries nor reaps", async () => {
  // Controlled protocol harness: it drives a terminal cancel outcome without
  // adding an injectable production constructor/API.
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: object;
    cancelAcquire(id: string, name: string): Promise<void>;
    close(): Promise<void>;
    beginReap(): void;
    sendRequest(op: string): {
      id: string;
      reply: Promise<{ ok: boolean; code: string; targetId?: string; name?: string; terminal?: "held" }>;
    };
  };
  const name = windowsNamedMutexName("cancel-held-rejected-release");
  let releases = 0;
  let reaps = 0;
  broker.child = {};
  broker.beginReap = () => {
    reaps += 1;
  };
  broker.sendRequest = (op: string) => {
    if (op === "cancel")
      return {
        id: "cancel",
        reply: Promise.resolve({ ok: true, code: "cancelled", targetId: "acquire", name, terminal: "held" }),
      };
    assert.equal(op, "release");
    releases += 1;
    return { id: "release", reply: Promise.resolve({ ok: false, code: "not_held" }) };
  };
  await assert.rejects(broker.cancelAcquire("acquire", name), /windows_named_mutex_cancel_failed/);
  assert.equal(releases, 1, "held cancellation attempts exactly one release");
  await assert.rejects(broker.close(), /windows_named_mutex_broker_containment_uncertain/);
  assert.equal(releases, 1, "close must not retry the uncertain release");
  assert.equal(reaps, 0, "close must not reap or kill after release uncertainty");
});

test("release pending rejection caused by sidecar failure contains before failure reaping", async () => {
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: object;
    releaseHeld(name: string): Promise<void>;
    sendRequest(op: string): { id: string; reply: Promise<never> };
    fail(error: Error): void;
    beginReap(): void;
    close(): Promise<void>;
  };
  const name = windowsNamedMutexName("release-fail-pending");
  let releases = 0;
  let reaps = 0;
  broker.child = {};
  broker.beginReap = () => {
    reaps += 1;
  };
  broker.sendRequest = (op: string) => {
    assert.equal(op, "release");
    releases += 1;
    broker.fail(new Error("sidecar_exit"));
    return { id: "release", reply: Promise.reject(new Error("sidecar_exit")) };
  };
  await assert.rejects(broker.releaseHeld(name), /windows_named_mutex_release_failed/);
  await assert.rejects(broker.close(), /windows_named_mutex_broker_containment_uncertain/);
  assert.equal(releases, 1, "containment forbids a second release");
  assert.equal(reaps, 0, "failure must not begin normal reaping during release");
});

test("nonlive broker release for a held lease contains before close can reap or retry", async () => {
  const broker = new WindowsNamedMutexBroker() as unknown as {
    releaseHeld(name: string): Promise<void>;
    beginReap(): void;
    close(): Promise<void>;
  };
  const name = windowsNamedMutexName("release-nonlive-held");
  let releases = 0;
  let reaps = 0;
  const originalReleaseHeld = broker.releaseHeld.bind(broker);
  broker.releaseHeld = async (heldName: string) => {
    releases += 1;
    return originalReleaseHeld(heldName);
  };
  broker.beginReap = () => {
    reaps += 1;
  };
  await assert.rejects(broker.releaseHeld(name), /windows_named_mutex_release_failed/);
  await assert.rejects(broker.close(), /windows_named_mutex_broker_containment_uncertain/);
  assert.equal(releases, 1, "close must not retry an unproved held release");
  assert.equal(reaps, 0, "close must not reap a sidecar after unavailable release");
});

test("malformed response during release contains before close can reap or retry", async () => {
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: { stdin: { write(data: string, encoding: BufferEncoding, callback: (error?: Error) => void): boolean } };
    releaseHeld(name: string): Promise<void>;
    handleLine(line: string): void;
    beginReap(): void;
    close(): Promise<void>;
  };
  const name = windowsNamedMutexName("release-malformed-response");
  let writes = 0;
  let reaps = 0;
  broker.child = {
    stdin: {
      write: () => {
        writes += 1;
        return true;
      },
    },
  };
  broker.beginReap = () => {
    reaps += 1;
  };
  const release = broker.releaseHeld(name);
  broker.handleLine("not-json");
  await assert.rejects(release, /windows_named_mutex_release_failed/);
  await assert.rejects(broker.close(), /windows_named_mutex_broker_containment_uncertain/);
  assert.equal(writes, 1, "containment forbids a second release write");
  assert.equal(reaps, 0, "malformed release response must not permit reaping or killing");
});

test("release write failures, including synchronous stdin write throws, contain before close can reap or retry", async () => {
  for (const failure of ["callback", "sync_throw"] as const) {
    const broker = new WindowsNamedMutexBroker() as unknown as {
      child?: { stdin: { write(data: string, encoding: BufferEncoding, callback: (error?: Error) => void): boolean } };
      releaseHeld(name: string): Promise<void>;
      beginReap(): void;
      close(): Promise<void>;
    };
    const name = windowsNamedMutexName(`release-write-failure-${failure}`);
    let writes = 0;
    let reaps = 0;
    broker.child = {
      stdin: {
        write: (_data, _encoding, callback) => {
          writes += 1;
          if (failure === "sync_throw") throw new Error("write_threw_synchronously");
          callback(new Error("write_failed"));
          return true;
        },
      },
    };
    broker.beginReap = () => {
      reaps += 1;
    };
    await assert.rejects(broker.releaseHeld(name), /windows_named_mutex_release_failed/);
    await assert.rejects(broker.close(), /windows_named_mutex_broker_containment_uncertain/);
    assert.equal(writes, 1, `${failure}: containment forbids a second release write`);
    assert.equal(reaps, 0, `${failure}: write failure must not permit reaping or killing`);
  }
});

test("held lease makes malformed and unsolicited sidecar replies contain before close releases or reaps", async () => {
  for (const line of ["not-json", JSON.stringify({ id: "unsolicited", ok: true, code: "acquired" })]) {
    const broker = new WindowsNamedMutexBroker() as unknown as {
      child?: object;
      leases: Set<{ release(): Promise<void>; markLost(): void }>;
      handleLine(line: string): void;
      beginReap(): void;
      close(): Promise<void>;
    };
    let releases = 0;
    let reaps = 0;
    broker.child = {};
    broker.leases.add({
      release: async () => {
        releases += 1;
      },
      markLost: () => undefined,
    });
    broker.beginReap = () => {
      reaps += 1;
    };
    broker.handleLine(line);
    await assert.rejects(broker.close(), /windows_named_mutex_broker_containment_uncertain/);
    assert.equal(releases, 0, "containment must precede close lease release");
    assert.equal(reaps, 0, "containment must prevent sidecar reap or kill");
  }
});

test("held lease makes acquire and cancel pending protocol errors contain before close releases or reaps", async () => {
  for (const op of ["acquire", "cancel"] as const) {
    const broker = new WindowsNamedMutexBroker() as unknown as {
      child?: object;
      leases: Set<{ release(): Promise<void>; markLost(): void }>;
      pending: Map<string, object>;
      handleLine(line: string): void;
      beginReap(): void;
      close(): Promise<void>;
    };
    let releases = 0;
    let reaps = 0;
    broker.child = {};
    broker.leases.add({
      release: async () => {
        releases += 1;
      },
      markLost: () => undefined,
    });
    broker.pending.set("pending", {
      op,
      name: windowsNamedMutexName(`pending-${op}`),
      resolve: () => undefined,
      reject: () => undefined,
    });
    broker.beginReap = () => {
      reaps += 1;
    };
    broker.handleLine("not-json");
    await assert.rejects(broker.close(), /windows_named_mutex_broker_containment_uncertain/);
    assert.equal(releases, 0, `${op} protocol failure must precede close lease release`);
    assert.equal(reaps, 0, `${op} protocol failure must prevent sidecar reap or kill`);
  }
});

test("concurrent lease release and broker close share one successful release", async () => {
  const broker = new WindowsNamedMutexBroker() as unknown as {
    child?: object;
    leases: Set<WindowsNamedMutexLease>;
    sendRequest(op: string): { id: string; reply: Promise<{ ok: boolean; code: string }> };
    beginReap(): void;
    close(): Promise<void>;
  };
  const name = windowsNamedMutexName("concurrent-release-close");
  let releaseRequests = 0;
  let reaps = 0;
  broker.child = {};
  broker.beginReap = () => {
    reaps += 1;
  };
  broker.sendRequest = (op: string) => {
    assert.equal(op, "release");
    releaseRequests += 1;
    return { id: "release", reply: Promise.resolve({ ok: true, code: "released" }) };
  };
  let lease!: WindowsNamedMutexLease;
  lease = new WindowsNamedMutexLease(
    name,
    "acquired",
    async () => {
      await (broker as unknown as { releaseLease(lease: WindowsNamedMutexLease): Promise<void> }).releaseLease(lease);
    },
    async () => undefined,
  );
  broker.leases.add(lease);
  await Promise.all([lease.release(), broker.close()]);
  assert.equal(releaseRequests, 1, "release and close must share one sidecar release");
  assert.ok(reaps >= 1, "normal close reaches its reap path after the shared successful release");
});

test(
  "held native mutex remains blocked after malformed sidecar reply and failed close",
  { skip: process.platform !== "win32" },
  async () => {
    const holder = new WindowsNamedMutexBroker();
    const contender = new WindowsNamedMutexBroker();
    const name = windowsNamedMutexName(unique());
    const rawHolder = holder as unknown as { handleLine(line: string): void; child?: ChildProcess };
    try {
      await holder.acquire(name);
      rawHolder.handleLine("not-json");
      await assert.rejects(holder.close(), /windows_named_mutex_broker_containment_uncertain/);
      await assert.rejects(contender.acquire(name, { timeoutMs: 50 }), /windows_named_mutex_timeout/);
    } finally {
      // Production containment intentionally refuses this cleanup. The test owns
      // this isolated sidecar and terminates it only after proving the mutex held.
      if (rawHolder.child) await reap(rawHolder.child);
      await contender.close();
    }
  },
);

test("production broker exposes no request or killForTest control-plane API", async () => {
  assert.equal("request" in WindowsNamedMutexBroker.prototype, false);
  assert.equal("killForTest" in WindowsNamedMutexBroker.prototype, false);
  // This test runs from the compiled verification artifact, so inspect the
  // emitted module that is actually executed rather than a source-only path.
  const source = await readFile(fileURLToPath(new URL("./windows-named-mutex-broker.js", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /public\s+(?:async\s+)?(?:request|killForTest)\b/);
});
