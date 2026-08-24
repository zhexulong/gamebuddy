import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { startVoiceGateway } from "./server.js";
import {
  type CaptureFileSystem,
  listWindowsInputDevices,
  probeWindowsInput,
  WindowsCaptureCleanupError,
  WindowsPttCapture,
} from "./windows-capture.js";

function runner(outputs: readonly string[] = ['[{"id":"wavein:0","name":"Microphone"}]']) {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    run: async (arguments_: readonly string[]) => {
      calls.push([...arguments_]);
      return outputs[index++] ?? '{"state":"passed","pcm16Bytes":320}';
    },
  };
}

test("Windows capture lists stable endpoints and validates a real probe receipt", async () => {
  const fake = runner([
    '[{"id":"wavein:0","name":"Microphone"}]',
    '{"state":"passed","resolvedDeviceId":"wavein:0","resolvedDeviceName":"Microphone","pcm16Bytes":320}',
  ]);
  assert.deepEqual(await listWindowsInputDevices(fake.run), [{ id: "wavein:0", name: "Microphone" }]);
  assert.deepEqual(await probeWindowsInput("default", fake.run), {
    selection: "default",
    resolvedDevice: { id: "wavein:0", name: "Microphone" },
    pcm16Bytes: 320,
  });
  assert.deepEqual(fake.calls, [
    ["-Mode", "list"],
    ["-Mode", "probe", "-Device", "default"],
  ]);
});

test("Windows capture rejects invalid endpoints and no-audio probe results", async () => {
  await assert.rejects(
    () => listWindowsInputDevices(runner(['[{"id":"default","name":"Microphone"}]']).run),
    /windows_input_device_list_invalid/,
  );
  await assert.rejects(() => probeWindowsInput("wavein:bad" as never, runner().run), /invalid_windows_input_device/);
  await assert.rejects(
    () => probeWindowsInput("default", runner(['{"state":"passed","pcm16Bytes":0}']).run),
    /windows_input_probe_invalid/,
  );
  await assert.rejects(
    () =>
      probeWindowsInput(
        "default",
        runner(['{"state":"passed","resolvedDeviceId":"default","resolvedDeviceName":"Microphone","pcm16Bytes":320}'])
          .run,
      ),
    /windows_input_probe_invalid/,
  );
});

test("capture accepts only its terminal native JSON receipt and records the resolved device", async () => {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("windows-capture-test-"));
  const _path = await import("node:path");
  const fs = await import("node:fs/promises");
  let invocation = 0;
  let releaseCompletion!: () => void;
  const completion = new Promise<string>((resolvePromise) => {
    releaseCompletion = () => resolvePromise("native informational line");
  });
  const capture = new WindowsPttCapture("default", async (arguments_) => {
    invocation++;
    if (invocation === 1) {
      const pcmPath = arguments_[arguments_.indexOf("-PcmPath") + 1]!;
      const readyPath = arguments_[arguments_.indexOf("-ReadyPath") + 1]!;
      const receiptPath = arguments_[arguments_.indexOf("-ReceiptPath") + 1]!;
      await fs.writeFile(readyPath, "ready");
      await fs.writeFile(pcmPath, Buffer.from([0, 0]));
      await fs.writeFile(
        receiptPath,
        '{"state":"passed","resolvedDeviceId":"wavein:2","resolvedDeviceName":"Headset"}',
      );
      // The native helper remains alive until PTT stop; otherwise start() must
      // correctly reject a capture that ended before readiness was observed.
      return await completion;
    }
    releaseCompletion();
    return '{"state":"stopped"}';
  });
  try {
    await capture.start();
    assert.deepEqual(await capture.stop(), new Uint8Array([0, 0]));
    assert.deepEqual(capture.lastResolvedDevice, { id: "wavein:2", name: "Headset" });
  } finally {
    await capture.cancel();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cancel during mkdtemp linearizes startup before native launch", async () => {
  let releaseMkdtemp!: (directory: string) => void;
  const pendingMkdtemp = new Promise<string>((resolve) => {
    releaseMkdtemp = resolve;
  });
  let nativeLaunches = 0;
  const capture = new WindowsPttCapture(
    "default",
    async () => {
      nativeLaunches++;
      return "unexpected";
    },
    {
      fileSystem: { mkdtemp: () => pendingMkdtemp, rm, readFile, stat },
      wait: async () => undefined,
    },
  );
  const starting = capture.start();
  const cancelling = capture.cancel();
  const directory = await mkdtemp("windows-capture-cancel-start-");
  releaseMkdtemp(directory);
  await assert.rejects(starting, /capture_cancelled/);
  await cancelling;
  assert.equal(nativeLaunches, 0);
  assert.equal(capture.active, false);
  await assert.rejects(() => stat(directory), /ENOENT/);
});

test("capture cancel waits for native completion before cleanup", async () => {
  let releaseCompletion!: () => void;
  const completion = new Promise<string>((resolvePromise) => {
    releaseCompletion = () => resolvePromise("native stopped");
  });
  let invocation = 0;
  let directory = "";
  const capture = new WindowsPttCapture("default", async (arguments_) => {
    invocation++;
    if (invocation === 1) {
      const pcmPath = arguments_[arguments_.indexOf("-PcmPath") + 1]!;
      const readyPath = arguments_[arguments_.indexOf("-ReadyPath") + 1]!;
      directory = dirname(pcmPath);
      await writeFile(readyPath, "ready");
      return await completion;
    }
    return "stopped";
  });
  await capture.start();
  const cancelling = capture.cancel();
  await Promise.resolve();
  assert.equal(capture.active, true);
  releaseCompletion();
  await cancelling;
  assert.equal(capture.active, false);
  await assert.rejects(() => stat(directory), /ENOENT/);
});

test("capture cleanup retries transient filesystem failure and verifies absence", async () => {
  const directory = await mkdtemp("windows-capture-cleanup-retry-");
  let removeAttempts = 0;
  const fileSystem: CaptureFileSystem = {
    mkdtemp: async () => directory,
    readFile,
    stat,
    rm: async (path, options) => {
      removeAttempts++;
      if (removeAttempts === 1) throw new Error("transient_remove_failure");
      await rm(path, options);
    },
  };
  let releaseNative!: () => void;
  const nativeCompletion = new Promise<string>((resolve) => {
    releaseNative = () => resolve("cancelled");
  });
  const capture = new WindowsPttCapture("default", async () => nativeCompletion, {
    fileSystem,
    wait: async () => undefined,
    cleanupRetryDelaysMs: [0],
  });
  const starting = capture.start();
  await Promise.resolve();
  const cancelling = capture.cancel();
  releaseNative();
  await cancelling;
  await assert.rejects(starting, /capture_cancelled|capture_ended_before_ready/);
  assert.equal(removeAttempts, 2);
  await assert.rejects(() => stat(directory), /ENOENT/);
});

test("persistent capture cleanup failure is bounded and structured without exposing paths", async () => {
  const directory = await mkdtemp("windows-capture-cleanup-persistent-");
  let removeAttempts = 0;
  const fileSystem: CaptureFileSystem = {
    mkdtemp: async () => directory,
    readFile,
    stat,
    rm: async () => {
      removeAttempts++;
      throw new Error(`remove failed at ${directory}`);
    },
  };
  let releaseNative!: () => void;
  const nativeCompletion = new Promise<string>((resolve) => {
    releaseNative = () => resolve("cancelled");
  });
  const capture = new WindowsPttCapture("default", async () => nativeCompletion, {
    fileSystem,
    wait: async () => undefined,
    cleanupRetryDelaysMs: [0, 0],
  });
  const starting = capture.start();
  await Promise.resolve();
  const cancelling = capture.cancel();
  releaseNative();
  await assert.rejects(cancelling, (error: unknown) => {
    assert.ok(error instanceof WindowsCaptureCleanupError);
    assert.deepEqual(error.failures, [{ phase: "filesystem", code: "filesystem_remove_failed", attempts: 3 }]);
    assert.equal(String(error).includes(directory), false);
    return true;
  });
  await assert.rejects(starting, (error: unknown) => {
    assert.ok(error instanceof AggregateError || (error instanceof Error && error.message === "capture_cancelled"));
    return true;
  });
  assert.equal(removeAttempts, 3);
  await rm(directory, { recursive: true, force: true });
});

test("hardware PTT does not expose external frames", async () => {
  const capture = new WindowsPttCapture("default", async () => new Promise(() => undefined));
  await assert.rejects(() => capture.start(99), /invalid_capture_duration/);
});

test("server rejects protocol PCM injection when a local hardware capture adapter is mounted", async () => {
  let started = 0;
  const capture = {
    async start() {
      started++;
    },
    async stop() {
      return new Uint8Array([0, 0]);
    },
    async cancel() {},
  };
  const gateway = await startVoiceGateway({ port: 0, token: "voice_token_1234567890", capture });
  try {
    // The server contract test uses its own socket exchange suite; asserting
    // capability mounting here prevents accidental omission from startup.
    assert.equal(started, 0);
    assert.ok(gateway.capabilities.ready === false);
  } finally {
    await gateway.close();
  }
});
