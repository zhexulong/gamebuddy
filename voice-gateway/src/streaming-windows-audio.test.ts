import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createStreamingWindowsAudioMixer } from "./streaming-windows-audio.js";

class FakeChild extends EventEmitter {
  stdin = new FakeStdin();
  stderr = new FakeStderr();
  stdout = new FakeStderr();
  killed = false;
  kill() {
    this.killed = true;
  }
}
class FakeStderr extends EventEmitter {
  setEncoding() {
    return this;
  }
}
class FakeStdin extends EventEmitter {
  writes: Uint8Array[] = [];
  ended = false;
  write(data: Uint8Array, cb?: (error?: Error | null) => void) {
    this.writes.push(Uint8Array.from(data));
    cb?.(undefined);
    return true;
  }
  end() {
    this.ended = true;
  }
}

function fakeSpawnRecord() {
  const child = new FakeChild();
  const records: { args: string[]; writes: Uint8Array[] }[] = [];
  const spawnFn = (_cmd: string, args: string[], _opts: unknown) => {
    records.push({ args, writes: child.stdin.writes });
    return child;
  };
  return { child, records, spawnFn };
}

test("streaming mixer spawns the resident stream with the requested device and a stream mode", async () => {
  const { child, records, spawnFn } = fakeSpawnRecord();
  // Resolve startup by not closing the child; the first write callback fires.
  const mixerPromise = createStreamingWindowsAudioMixer("default", spawnFn as never);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]!.args.slice(-4), ["-Mode", "stream", "-Device", "default"]);
  // Startup probe: first frame is a 10ms silent frame (320 bytes) with a 4-byte LE length prefix.
  assert.equal(child.stdin.writes.length, 1);
  assert.equal(child.stdin.writes[0]!.byteLength, 324);
  const probe = child.stdin.writes[0]!;
  assert.equal(new DataView(probe.buffer).getUint32(0, true), 320);
  const mixer = await mixerPromise;
  await mixer.close();
});

test("streaming mixer play() streams individual micro-chunks as length-prefixed frames", async () => {
  const { child, spawnFn } = fakeSpawnRecord();
  const mixer = await createStreamingWindowsAudioMixer("default", spawnFn as never);
  const before = child.stdin.writes.length;
  await mixer.play("job", 1, new Uint8Array([1, 2, 3, 4, 5, 6]));
  const frame = child.stdin.writes[before]!;
  assert.equal(frame.byteLength, 4 + 6);
  assert.equal(new DataView(frame.buffer).getUint32(0, true), 6);
  assert.deepEqual([...frame.subarray(4)], [1, 2, 3, 4, 5, 6]);
  await mixer.close();
});

test("streaming mixer stop() sends a zero-length stop frame and marks closed", async () => {
  const { child, spawnFn } = fakeSpawnRecord();
  const mixer = await createStreamingWindowsAudioMixer("default", spawnFn as never);
  const before = child.stdin.writes.length;
  mixer.stop();
  const frame = child.stdin.writes[before]!;
  assert.equal(frame.byteLength, 4);
  assert.equal(new DataView(frame.buffer).getUint32(0, true), 0);
  assert.equal(mixer.ready, false);
  await assert.rejects(async () => { await mixer.play("job", 2, new Uint8Array(4)); }, /windows_stream_closed/);
  await mixer.close();
});

test("streaming mixer fails closed when the resident process dies", async () => {
  const { child, spawnFn } = fakeSpawnRecord();
  const mixer = await createStreamingWindowsAudioMixer("default", spawnFn as never);
  child.emit("close", 1);
  assert.equal(mixer.ready, false);
  assert.ok(mixer.failureReason !== undefined);
  await assert.rejects(async () => { await mixer.play("job", 3, new Uint8Array(4)); });
  await mixer.close();
});

test("streaming mixer accepts a named waveout endpoint and rejects invalid selections", async () => {
  const { spawnFn } = fakeSpawnRecord();
  const mixer = await createStreamingWindowsAudioMixer("waveout:2", spawnFn as never);
  assert.equal(mixer.device, "waveout:2");
  await mixer.close();
  await assert.rejects(
    () => createStreamingWindowsAudioMixer("waveout:not-a-number", spawnFn as never),
    /invalid_windows_output_device/,
  );
});

test("streaming mixer rejects oversized/odd PCM frames with a structured failure", async () => {
  const { child, spawnFn } = fakeSpawnRecord();
  const mixer = await createStreamingWindowsAudioMixer("default", spawnFn as never);
  await assert.rejects(async () => { await mixer.play("job", 4, new Uint8Array(1)); }, /windows_playback_rejected/);
  await assert.rejects(async () => { await mixer.play("job", 4, new Uint8Array(1_920_002)); }, /windows_playback_rejected/);
  assert.equal(mixer.ready, false);
  // The stream child was failed closed; subsequent writes stay rejected.
  assert.equal(child.stdin.ended, true);
  await mixer.close();
});