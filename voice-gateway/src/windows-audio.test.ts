import assert from "node:assert/strict";
import test from "node:test";

import { createWindowsAudioMixer, listWindowsOutputDevices, probeWindowsOutput } from "./windows-audio.js";

function runner(output = '[{"id":"waveout:0","name":"Speakers"}]') {
  const calls: string[][] = [];
  return {
    calls,
    run: async (arguments_: readonly string[]) => {
      calls.push([...arguments_]);
      return output;
    },
  };
}

test("Windows output selection enumerates stable endpoints and probes the current default", async () => {
  const fake = runner();
  const devices = await listWindowsOutputDevices(fake.run);
  assert.deepEqual(devices, [{ id: "waveout:0", name: "Speakers" }]);
  await probeWindowsOutput("default", fake.run);
  assert.deepEqual(fake.calls, [
    ["-Mode", "list"],
    ["-Mode", "probe", "-Device", "default"],
  ]);
});

test("invalid endpoint enumeration fails closed", async () => {
  await assert.rejects(
    () => listWindowsOutputDevices(runner('[{"id":"default","name":"Speakers"}]').run),
    /windows_output_device_list_invalid/,
  );
  await assert.rejects(() => probeWindowsOutput("waveout:bad" as never, runner().run), /invalid_windows_output_device/);
});

test("mixer is ready only after probe and revokes readiness when a real write fails", async () => {
  const fake = runner();
  const mixer = await createWindowsAudioMixer("waveout:2", fake.run);
  assert.equal(mixer.ready, true);
  await mixer.play("job", 0, new Uint8Array([0, 0]));
  assert.deepEqual(fake.calls, [
    ["-Mode", "probe", "-Device", "waveout:2"],
    ["-Mode", "play", "-Device", "waveout:2", "-PcmPath", fake.calls[1]![5]!],
  ]);

  const failing = async () => {
    throw new Error("waveout_open_4");
  };
  const failed = await createWindowsAudioMixer("default", failing);
  assert.equal(failed.ready, false);
  assert.match(failed.failureReason ?? "", /waveout_open_4/);
});
