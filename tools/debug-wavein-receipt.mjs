import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "gamebuddy-wavein-receipt-debug-"));
const eventName = `GameBuddyWaveInDebug_${Date.now()}`;
const paths = {
  pcm: join(directory, "capture.pcm"),
  ready: join(directory, "capture.ready"),
  receipt: join(directory, "capture.receipt.json"),
};
const script = new URL("../voice-gateway/windows-wavein.ps1", import.meta.url).pathname.replace(/^\//, "");
const child = spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Mode",
    "capture",
    "-Device",
    "default",
    "-PcmPath",
    paths.pcm,
    "-ReadyPath",
    paths.ready,
    "-ReceiptPath",
    paths.receipt,
    "-EventName",
    eventName,
    "-MaxDurationMs",
    "1000",
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let stdout = "",
  stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (x) => (stdout += x));
child.stderr.on("data", (x) => (stderr += x));
try {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await stat(paths.ready);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  const stopper = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Mode",
      "stop",
      "-Device",
      "default",
      "-EventName",
      eventName,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  await new Promise((resolve) => stopper.once("close", resolve));
  const code = await new Promise((resolve) => child.once("close", resolve));
  const receipt = await readFile(paths.receipt, "utf8").catch((error) => `<missing:${error.code}>`);
  const pcm = await stat(paths.pcm)
    .then((value) => value.size)
    .catch(() => null);
  console.log(
    JSON.stringify(
      {
        state: "completed",
        exitCode: code,
        receiptRaw: receipt,
        pcmBytes: pcm,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
