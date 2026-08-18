import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";

import { startCompanionControlServer, readProductControlLaunch } from "./companion-control-server.js";

const launch = Object.freeze({ pipeName: "control_pipe_01", launchToken: "A123456789012345678901234567890" });

test("product control launch fails closed outside Windows and never defaults credentials", () => {
  assert.throws(() => readProductControlLaunch({}), /windows_product_control_required|invalid_gamebuddy_control_pipe/);
});

test("control-pipe helper bounds each frame and gives trickle bytes one monotonic deadline", () => {
  // Windows pipe integration is not available in this test process. Assert the
  // source-level transport invariants that prevent an unbounded ReadLineAsync
  // allocation and prove that every byte wait consumes one frame-wide monotonic
  // budget instead of renewing FrameTimeoutMs for a trickle client.
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "resources", "windows-current-user-control-pipe.ps1"),
    "utf8",
  );
  assert.doesNotMatch(source, /ReadLineAsync/);
  assert.match(source, /function Read-BoundedUtf8Frame/);
  assert.match(source, /New-Object byte\[\] 16384/);
  const reader = source.match(/function Read-BoundedUtf8Frame[\s\S]*?\n\}/)?.[0];
  assert.ok(reader, "bounded reader function was not found");
  assert.match(reader, /\$frameStopwatch = \[System\.Diagnostics\.Stopwatch\]::StartNew\(\)/);
  assert.equal(
    (reader.match(/Stopwatch\]::StartNew\(\)/g) ?? []).length,
    1,
    "one stopwatch must cover the complete frame",
  );
  assert.match(
    reader,
    /\$remainingMs = \[int\]\[Math\]::Floor\(\$TimeoutMs - \$frameStopwatch\.Elapsed\.TotalMilliseconds\)\s+if \(\$remainingMs -le 0\) \{ throw 'control_client_frame_timeout' \}\s+\$read = \$Pipe\.ReadAsync\(\$oneByte,0,1\)\s+if \(-not \$read\.Wait\(\$remainingMs\)\) \{ throw 'control_client_frame_timeout' \}/,
  );
  assert.doesNotMatch(reader, /\$read\.Wait\(\$TimeoutMs\)/);
  assert.match(source, /if \(\$count -eq 0 -and -not \$sawCr\) \{ return \$null \}/);
  assert.match(source, /if \(\$count -ge \$payload\.Length\) \{ throw 'control_client_frame_invalid' \}/);
  assert.match(source, /UTF8Encoding\]::new\(\$false,\$true\)\.GetString/);
  assert.match(source, /if \(\$null -eq \$line\) \{ break \}/);
  assert.match(source, /\$line = Read-BoundedUtf8Frame \$pipe \$FrameTimeoutMs/);
  assert.match(source, /if \(\$null -eq \$response\) \{ throw 'control_broker_exit' \}/);
  assert.match(
    source,
    /if \(\$null -eq \$remoteSid -or \$remoteSid -ne \$sid\.Value\) \{ throw 'client_sid_revalidation_failed' \}/,
  );
  assert.match(source, /foreach \(\$resource in @\(\$writer,\$pipe\)\) \{/);
});

class FakeHelper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  writes = 0;
  kills = 0;
  exitOnKill = true;
  readonly #pendingReplies = new Map<string, Array<(reply: Record<string, unknown>) => void>>();
  constructor() {
    super();
    this.stdin.on("data", (data: Buffer) => {
      for (const line of data.toString("utf8").split("\n")) {
        if (line.length === 0) continue;
        this.writes += 1;
        const frame = JSON.parse(line) as { connectionId: string; reply: Record<string, unknown> };
        const next = this.#pendingReplies.get(frame.connectionId)?.shift();
        if (next === undefined) throw new Error(`unexpected_fake_helper_reply:${frame.connectionId}`);
        next(frame.reply);
      }
    });
  }
  nextReply(connectionId: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const queue = this.#pendingReplies.get(connectionId) ?? [];
      queue.push(resolve);
      this.#pendingReplies.set(connectionId, queue);
    });
  }
  kill() {
    this.kills += 1;
    if (this.exitOnKill) this.emit("exit", 0);
    return true;
  }
}

async function frame(helper: FakeHelper, connectionId: string, request: object): Promise<Record<string, unknown>> {
  return rawFrame(helper, connectionId, JSON.stringify(request));
}

async function rawFrame(helper: FakeHelper, connectionId: string, line: string): Promise<Record<string, unknown>> {
  const reply = helper.nextReply(connectionId);
  helper.stdout.write(`${JSON.stringify({ connectionId, line })}\n`);
  return await reply;
}

class ManualFrameScheduler {
  readonly callbacks: Array<{ callback: () => void; cancelled: boolean }> = [];
  schedule = (callback: () => void): (() => void) => {
    const entry = { callback, cancelled: false };
    this.callbacks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  fire(index: number): void {
    const entry = this.callbacks[index]!;
    assert.equal(entry.cancelled, false, `timer ${index} was unexpectedly cancelled`);
    entry.callback();
  }
}

test("malformed helper-forwarded client frames seal without writing a response", async () => {
  const invalidLines = [
    "",
    "not-json",
    '{"type":"hello","type":"hello","protocolVersion":1,"launchToken":"A123456789012345678901234567890"}',
    '{"type":"hello","protocolVersion":2,"launchToken":"A123456789012345678901234567890"}',
    '{"type":"player_input"}',
  ];
  for (const line of invalidLines) {
    const helper = new FakeHelper();
    const target = {
      acceptPlayerInput: async () => {
        throw new Error("target must not run");
      },
      stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
    };
    const server = startCompanionControlServer(launch, target, {
      platform: "win32",
      spawnHelper: () => helper as never,
      requestTimeoutMs: 50,
    });
    try {
      helper.stdout.write(`${JSON.stringify({ connectionId: "connection_01", line })}\n`);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(helper.writes, 0, `invalid line unexpectedly received an error reply: ${line}`);
      assert.equal(helper.kills, 1, `invalid line did not terminate the helper: ${line}`);
    } finally {
      await server.close();
    }
  }
});

test("a valid hello claims the launch token server-wide while rejected hellos do not consume it", async () => {
  const helper = new FakeHelper();
  const target = {
    acceptPlayerInput: async () => {},
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 50,
  });
  try {
    assert.equal(
      (
        await frame(helper, "connection_wrong", {
          type: "hello",
          protocolVersion: 1,
          launchToken: "B123456789012345678901234567890",
        })
      ).code,
      "control_hello_rejected",
    );
    assert.equal(
      (await frame(helper, "connection_first", { type: "hello", protocolVersion: 1, launchToken: launch.launchToken }))
        .ok,
      true,
    );
    assert.equal(
      (await frame(helper, "connection_second", { type: "hello", protocolVersion: 1, launchToken: launch.launchToken }))
        .code,
      "control_hello_rejected",
    );
    assert.equal(
      (await frame(helper, "connection_first", { type: "hello", protocolVersion: 1, launchToken: launch.launchToken }))
        .code,
      "control_hello_rejected",
    );
  } finally {
    await server.close();
  }
});

test("validated request-target errors reply normally without sealing the helper", async () => {
  const helper = new FakeHelper();
  const target = {
    acceptPlayerInput: async (input: { sourceEventId: string }) => {
      if (input.sourceEventId === "source_target_rejected") throw new Error("target_rejected");
    },
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 50,
  });
  try {
    assert.equal(
      (
        await frame(helper, "connection_01", {
          type: "hello",
          protocolVersion: 1,
          launchToken: "B123456789012345678901234567890",
        })
      ).code,
      "control_hello_rejected",
    );
    const hello = await frame(helper, "connection_01", {
      type: "hello",
      protocolVersion: 1,
      launchToken: launch.launchToken,
    });
    const runtimeInstanceId = hello.runtimeInstanceId as string;
    assert.equal(
      (
        await frame(helper, "connection_01", {
          type: "player_input",
          requestId: "request_bad_runtime",
          runtimeInstanceId: "other_runtime",
          sourceEventId: "source_bad_runtime",
          text: "hello",
          locale: "en-US",
        })
      ).code,
      "control_runtime_mismatch",
    );
    assert.equal(
      (
        await frame(helper, "connection_01", {
          type: "player_input",
          requestId: "request_target_rejected",
          runtimeInstanceId,
          sourceEventId: "source_target_rejected",
          text: "hello",
          locale: "en-US",
        })
      ).code,
      "target_rejected",
    );
    assert.deepEqual(
      await frame(helper, "connection_01", {
        type: "player_input",
        requestId: "request_good_runtime",
        runtimeInstanceId,
        sourceEventId: "source_good_runtime",
        text: "hello",
        locale: "en-US",
      }),
      { ok: true, accepted: "player_input" },
    );
    assert.equal(helper.kills, 0);
  } finally {
    await server.close();
  }
});

test("normal deliberate close and expected helper exit do not trigger duplicate safety cleanup", async () => {
  const helper = new FakeHelper();
  const target = {
    acceptPlayerInput: async () => {},
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 50,
  });
  await server.close();
  assert.doesNotThrow(() => helper.stdout.emit("error", new Error("teardown_stdout_error")));
  helper.stdout.emit("close");
  assert.equal(helper.kills, 1);
});

test("live helper stdout loss seals, cancels waiters, and permits no late writes", async () => {
  for (const event of ["end", "close", "error"] as const) {
    const helper = new FakeHelper();
    let release!: () => void;
    const target = {
      acceptPlayerInput: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
    };
    const server = startCompanionControlServer(launch, target, {
      platform: "win32",
      spawnHelper: () => helper as never,
      requestTimeoutMs: 50,
    });
    try {
      const hello = await frame(helper, "connection_01", {
        type: "hello",
        protocolVersion: 1,
        launchToken: launch.launchToken,
      });
      void frame(helper, "connection_01", {
        type: "player_input",
        requestId: `request_stdout_${event}`,
        runtimeInstanceId: hello.runtimeInstanceId as string,
        sourceEventId: `source_stdout_${event}`,
        text: "wait",
        locale: "en-US",
      });
      await new Promise((resolve) => setImmediate(resolve));
      const writesBeforeLoss = helper.writes;
      if (event === "error") assert.doesNotThrow(() => helper.stdout.emit(event, new Error("stdout_failed")));
      else helper.stdout.emit(event);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(helper.kills, 1, `${event} did not terminate a still-live helper`);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(helper.writes, writesBeforeLoss, `${event} permitted a late target reply`);
      // terminateHelper() must cause exactly one expected child exit, allowing
      // close() to complete immediately rather than consuming its fallback.
      assert.equal(helper.listenerCount("exit"), 0, `${event} left close cleanup waiting for exit`);
    } finally {
      await server.close();
    }
  }
});

test("duplicate arriving just before the original deadline has its own per-frame deadline and executes once", async () => {
  const helper = new FakeHelper();
  const scheduler = new ManualFrameScheduler();
  let release!: () => void;
  let executions = 0;
  const target = {
    acceptPlayerInput: async () => {
      executions++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 25,
    scheduleTimeout: (callback) => scheduler.schedule(callback),
  });
  try {
    const helloOne = await frame(helper, "connection_01", {
      type: "hello",
      protocolVersion: 1,
      launchToken: launch.launchToken,
    });
    const runtimeInstanceId = helloOne.runtimeInstanceId as string;
    const request = {
      type: "player_input",
      requestId: "request_concurrent",
      runtimeInstanceId,
      sourceEventId: "source_concurrent",
      text: "wait",
      locale: "en-US",
    };
    const original = frame(helper, "connection_01", request);
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = frame(helper, "connection_01", request);
    await new Promise((resolve) => setImmediate(resolve));
    // The original deadline follows the sole successful hello at index 1; the
    // duplicate's independent waiter is index 2. Firing only index 1 must not
    // settle the duplicate.
    scheduler.fire(1);
    assert.equal((await original).code, "control_request_timeout");
    assert.equal(executions, 1);
    assert.equal(helper.writes, 2, "duplicate did not inherit the original timeout");
    scheduler.fire(2);
    assert.equal((await duplicate).code, "control_request_timeout");
    assert.equal(executions, 1);
    release();
  } finally {
    await server.close();
  }
});

test("idempotency fingerprints use validated request semantics rather than JSON spelling", async () => {
  const helper = new FakeHelper();
  let executions = 0;
  const target = {
    acceptPlayerInput: async () => {
      executions += 1;
    },
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 50,
  });
  try {
    const hello = await frame(helper, "connection_01", {
      type: "hello",
      protocolVersion: 1,
      launchToken: launch.launchToken,
    });
    const runtimeInstanceId = hello.runtimeInstanceId as string;
    const first = `{"type":"player_input","requestId":"request_semantic","runtimeInstanceId":"${runtimeInstanceId}","sourceEventId":"source_semantic","text":"café","locale":"en-US"}`;
    const equivalent = `{ "locale" : "en-\\u0055S", "text" : "caf\\u00e9", "sourceEventId" : "source_semantic", "runtimeInstanceId" : "${runtimeInstanceId}", "requestId" : "request_semantic", "type" : "player_input" }`;
    assert.deepEqual(await rawFrame(helper, "connection_01", first), { ok: true, accepted: "player_input" });
    assert.deepEqual(await rawFrame(helper, "connection_01", equivalent), { ok: true, accepted: "player_input" });
    assert.equal(executions, 1);
    const changed = equivalent.replace("source_semantic", "source_changed");
    assert.equal((await rawFrame(helper, "connection_01", changed)).code, "control_idempotency_collision");
    const stop = {
      type: "stop_all",
      requestId: "request_stop_semantic",
      runtimeInstanceId,
      stopId: "stop_semantic",
      sourceEventId: "source_stop",
    };
    assert.deepEqual(await frame(helper, "connection_01", stop), { ok: true, accepted: "stop_all" });
  } finally {
    await server.close();
  }
});

test("STOP replies distinguish a Host-confirmed active Pi turn from an idle no-op", async () => {
  const helper = new FakeHelper();
  const outcomes = ["active_turn_cancelled", "queued_turn_cancelled", "no_active_turn"] as const;
  let nextOutcome = 0;
  const target = {
    acceptPlayerInput: async () => {},
    stopAll: () => ({ admission: { accepted: true }, outcome: outcomes[nextOutcome++]!, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 50,
  });
  try {
    const hello = await frame(helper, "connection_01", {
      type: "hello",
      protocolVersion: 1,
      launchToken: launch.launchToken,
    });
    const stop = (requestId: string, stopId: string) =>
      frame(helper, "connection_01", {
        type: "stop_all",
        requestId,
        runtimeInstanceId: hello.runtimeInstanceId,
        stopId,
        sourceEventId: `source_${stopId}`,
      });
    assert.deepEqual(await stop("request_stop_active", "stop_active"), { ok: true, accepted: "active_turn_cancelled" });
    assert.deepEqual(await stop("request_stop_queued", "stop_queued"), { ok: true, accepted: "queued_turn_cancelled" });
    assert.deepEqual(await stop("request_stop_idle", "stop_idle"), { ok: true, accepted: "no_active_turn" });
  } finally {
    await server.close();
  }
});

test("repeated child errors seal once and are all consumed during teardown", async () => {
  const helper = new FakeHelper();
  const target = {
    acceptPlayerInput: async () => {
      throw new Error("target must not run");
    },
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 50,
  });
  try {
    assert.doesNotThrow(() => helper.emit("error", new Error("first_child_error")));
    assert.equal(helper.kills, 1);
    assert.doesNotThrow(() => helper.emit("error", new Error("later_child_error")));
    assert.doesNotThrow(() => helper.emit("error", new Error("last_child_error")));
    assert.equal(helper.kills, 1, "later child errors duplicated cleanup");
    await server.close();
  } finally {
    await server.close();
  }
});

test("stdout EOF residual valid frame is sealed before it can call the target", async () => {
  const helper = new FakeHelper();
  let playerInputs = 0;
  let stops = 0;
  const target = {
    acceptPlayerInput: async () => {
      playerInputs += 1;
    },
    stopAll: () => {
      stops += 1;
      return { admission: { accepted: true }, settled: Promise.resolve() };
    },
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 50,
  });
  try {
    // A normal complete line before the seal remains valid and authenticates
    // this connection. Only the EOF-flushed, otherwise valid residual is
    // forbidden from crossing into either target method.
    await frame(helper, "connection_01", { type: "hello", protocolVersion: 1, launchToken: launch.launchToken });
    const writesBeforeEof = helper.writes;
    const residual = JSON.stringify({
      connectionId: "connection_01",
      line: JSON.stringify({
        type: "player_input",
        requestId: "request_residual",
        runtimeInstanceId: server.runtimeInstanceId,
        sourceEventId: "source_residual",
        text: "late",
        locale: "en-US",
      }),
    });
    // No newline: ReadLine's input-end listener synchronously flushes this
    // residual. The server's stdout end listener was installed before
    // createInterface(), so EventEmitter invokes it first and seals the
    // server before that ReadLine flush can reach its line listener.
    helper.stdout.write(residual);
    helper.stdout.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(playerInputs, 0);
    assert.equal(stops, 0);
    assert.equal(helper.writes, writesBeforeEof, "sealed EOF residual received a reply");
    assert.equal(helper.kills, 1, "stdout EOF did not terminate exactly once");
  } finally {
    await server.close();
  }
});

test("helper stdin errors seal once without unhandled errors or cleanup writes", async () => {
  const helper = new FakeHelper();
  const target = {
    acceptPlayerInput: async () => {},
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 50,
  });
  try {
    helper.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    await new Promise((resolve) => setImmediate(resolve));
    const writesAfterSeal = helper.writes;
    helper.stdin.emit("error", new Error("second_error"));
    await server.close();
    assert.equal(helper.writes, writesAfterSeal);
  } finally {
    await server.close();
  }
});

test("synchronous helper stdin write and end failures are sealed without throwing", async () => {
  const helper = new FakeHelper();
  const originalWrite = helper.stdin.write.bind(helper.stdin);
  let writeCalls = 0;
  (helper.stdin.write as unknown) = (() => {
    writeCalls += 1;
    throw new Error("write_after_end");
  }) as never;
  (helper.stdin.end as unknown) = (() => {
    throw new Error("end_after_failure");
  }) as never;
  const target = {
    acceptPlayerInput: async () => {},
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 50,
  });
  try {
    const reply = helper.nextReply("connection_01");
    helper.stdout.write(
      `${JSON.stringify({ connectionId: "connection_01", line: JSON.stringify({ type: "hello", protocolVersion: 1, launchToken: launch.launchToken }) })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writeCalls, 1);
    await server.close();
    await Promise.race([
      reply,
      new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({ sealed: true }), 10)),
    ]);
  } finally {
    // Restore only to let the mocked stream be garbage-collected normally.
    (helper.stdin.write as unknown) = originalWrite as never;
    await server.close();
  }
});

test("original timeout then terminal settle returns cached success to a later duplicate", async () => {
  const helper = new FakeHelper();
  let release!: () => void;
  let executions = 0;
  const target = {
    acceptPlayerInput: async () => {
      executions++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 15,
  });
  try {
    const hello = await frame(helper, "connection_01", {
      type: "hello",
      protocolVersion: 1,
      launchToken: launch.launchToken,
    });
    const runtimeInstanceId = hello.runtimeInstanceId as string;
    const request = {
      type: "player_input",
      requestId: "request_cached",
      runtimeInstanceId,
      sourceEventId: "source_cached",
      text: "wait",
      locale: "en-US",
    };
    assert.equal((await frame(helper, "connection_01", request)).code, "control_request_timeout");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await frame(helper, "connection_01", request), { ok: true, accepted: "player_input" });
    assert.equal(executions, 1);
  } finally {
    await server.close();
  }
});

test("late duplicate independently waits for a live target and gets its result within its own deadline", async () => {
  const helper = new FakeHelper();
  let release!: () => void;
  let executions = 0;
  const target = {
    acceptPlayerInput: async () => {
      executions++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 30,
  });
  try {
    const hello = await frame(helper, "connection_01", {
      type: "hello",
      protocolVersion: 1,
      launchToken: launch.launchToken,
    });
    const runtimeInstanceId = hello.runtimeInstanceId as string;
    const request = {
      type: "player_input",
      requestId: "request_late_success",
      runtimeInstanceId,
      sourceEventId: "source_late_success",
      text: "wait",
      locale: "en-US",
    };
    assert.equal((await frame(helper, "connection_01", request)).code, "control_request_timeout");
    const duplicate = frame(helper, "connection_01", request);
    setTimeout(release, 5);
    assert.deepEqual(await duplicate, { ok: true, accepted: "player_input" });
    assert.equal(executions, 1);
  } finally {
    await server.close();
  }
});

test("late duplicate times out on its own deadline while the target remains live", async () => {
  const helper = new FakeHelper();
  let release!: () => void;
  let executions = 0;
  const target = {
    acceptPlayerInput: async () => {
      executions++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 15,
  });
  try {
    const hello = await frame(helper, "connection_01", {
      type: "hello",
      protocolVersion: 1,
      launchToken: launch.launchToken,
    });
    const runtimeInstanceId = hello.runtimeInstanceId as string;
    const request = {
      type: "player_input",
      requestId: "request_late_timeout",
      runtimeInstanceId,
      sourceEventId: "source_late_timeout",
      text: "wait",
      locale: "en-US",
    };
    assert.equal((await frame(helper, "connection_01", request)).code, "control_request_timeout");
    assert.equal((await frame(helper, "connection_01", request)).code, "control_request_timeout");
    assert.equal(executions, 1);
    release();
  } finally {
    await server.close();
  }
});

async function startPendingOriginalAndDuplicate(helper: FakeHelper) {
  let executions = 0;
  const target = {
    acceptPlayerInput: async () => {
      executions += 1;
      await new Promise<void>(() => {});
    },
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 50,
  });
  const hello = await frame(helper, "connection_01", {
    type: "hello",
    protocolVersion: 1,
    launchToken: launch.launchToken,
  });
  const runtimeInstanceId = hello.runtimeInstanceId as string;
  const request = {
    type: "player_input",
    requestId: "request_close_pending",
    runtimeInstanceId,
    sourceEventId: "source_close_pending",
    text: "wait",
    locale: "en-US",
  };
  void frame(helper, "connection_01", request);
  await new Promise((resolve) => setImmediate(resolve));
  void frame(helper, "connection_01", request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
  return server;
}

test("close cancels original and duplicate waiters without late helper writes", async () => {
  const helper = new FakeHelper();
  const server = await startPendingOriginalAndDuplicate(helper);
  const writesBeforeClose = helper.writes;
  await Promise.race([
    server.close(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close_did_not_resolve")), 100)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(helper.writes, writesBeforeClose);
});

test("helper seal cancels original and duplicate waiters without late helper writes", async () => {
  const helper = new FakeHelper();
  const server = await startPendingOriginalAndDuplicate(helper);
  const writesBeforeSeal = helper.writes;
  helper.emit("error", new Error("helper_failed"));
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(helper.writes, writesBeforeSeal);
  await server.close();
});

test("timeout reply never evicts its live idempotency reservation", async () => {
  const helper = new FakeHelper();
  let release!: () => void;
  let executions = 0;
  const target = {
    acceptPlayerInput: async (input: { sourceEventId: string }) => {
      executions++;
      if (input.sourceEventId === "source_live")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
    stopAll: () => ({ admission: { accepted: true }, settled: Promise.resolve() }),
  };
  const server = startCompanionControlServer(launch, target, {
    platform: "win32",
    spawnHelper: () => helper as never,
    requestTimeoutMs: 5,
  });
  try {
    const hello = await frame(helper, "connection_01", {
      type: "hello",
      protocolVersion: 1,
      launchToken: launch.launchToken,
    });
    const runtimeInstanceId = hello.runtimeInstanceId as string;
    const original = frame(helper, "connection_01", {
      type: "player_input",
      requestId: "request_live",
      runtimeInstanceId,
      sourceEventId: "source_live",
      text: "wait",
      locale: "en-US",
    });
    assert.equal((await original).code, "control_request_timeout");
    for (let index = 0; index < 255; index += 1) {
      const requestId = `request_${index}`;
      const reply = await frame(helper, "connection_01", {
        type: "player_input",
        requestId,
        runtimeInstanceId,
        sourceEventId: `source_${index}`,
        text: "other",
        locale: "en-US",
      });
      assert.equal(reply.ok, true);
    }
    const capacity = await frame(helper, "connection_01", {
      type: "player_input",
      requestId: "request_capacity",
      runtimeInstanceId,
      sourceEventId: "source_capacity",
      text: "other",
      locale: "en-US",
    });
    assert.equal(capacity.code, "control_idempotency_capacity");
    const retry = await frame(helper, "connection_01", {
      type: "player_input",
      requestId: "request_live",
      runtimeInstanceId,
      sourceEventId: "source_live",
      text: "wait",
      locale: "en-US",
    });
    assert.equal(retry.code, "control_request_timeout");
    const collision = await frame(helper, "connection_01", {
      type: "player_input",
      requestId: "request_live",
      runtimeInstanceId,
      sourceEventId: "source_other",
      text: "other",
      locale: "en-US",
    });
    assert.equal(collision.code, "control_idempotency_collision");
    assert.equal(executions, 256);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executions, 256);
  } finally {
    await server.close();
  }
});
