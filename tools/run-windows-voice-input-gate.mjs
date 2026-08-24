import { spawn } from "node:child_process";

const device = option("--device", "default");
const durationMs = Number(option("--duration-ms", "1000"));
if (
  !/^default$|^wavein:[0-9]{1,4}$/.test(device) ||
  !Number.isInteger(durationMs) ||
  durationMs < 100 ||
  durationMs > 30_000
)
  throw new Error("invalid_windows_input_gate_options");
const script = new URL("../voice-gateway/windows-wavein.ps1", import.meta.url).pathname.replace(
  /^\//,
  process.platform === "win32" ? "" : "/",
);
let output;
let result;
try {
  output = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Mode",
    "probe",
    "-Device",
    device,
  ]);
  result = JSON.parse(output);
} catch (error) {
  console.log(
    JSON.stringify(
      {
        state: "blocked",
        gate: "windows_ptt_input",
        selection: device,
        resolvedDevice: null,
        pcm16Bytes: null,
        format: null,
        transcription: "not_attempted",
        failure: sanitizeFailure(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
  process.exit();
}
const resolved =
  typeof result?.resolvedDeviceId === "string" &&
  /^wavein:[0-9]{1,4}$/.test(result.resolvedDeviceId) &&
  typeof result?.resolvedDeviceName === "string" &&
  result.resolvedDeviceName.trim().length > 0
    ? { id: result.resolvedDeviceId, name: result.resolvedDeviceName.trim() }
    : null;
const passed =
  result?.state === "passed" &&
  resolved !== null &&
  Number.isSafeInteger(result.pcm16Bytes) &&
  result.pcm16Bytes > 0 &&
  result.pcm16Bytes <= 960_000 &&
  result.pcm16Bytes % 2 === 0;
console.log(
  JSON.stringify(
    {
      state: passed ? "passed" : "blocked",
      gate: "windows_ptt_input",
      selection: device,
      resolvedDevice: passed ? resolved : null,
      pcm16Bytes: passed ? result.pcm16Bytes : null,
      format: passed ? { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" } : null,
      transcription: "not_attempted",
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 2;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `windows_input_gate_exit_${code ?? -1}`)),
    );
  });
}
function sanitizeFailure(error) {
  const text = error instanceof Error ? error.message : "windows_input_probe_failed";
  const match = text.match(/wavein_[a-z0-9_]+/i);
  return match?.[0] ?? "windows_input_probe_failed";
}
