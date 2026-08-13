import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";

const outputDevice = option("--device", "default");
const voice = option("--voice");
const port = Number(option("--port", "49731"));
const token = option("--token");
if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token))
  throw new Error("invalid_voice_gate_options");

const key = process.env.MIMO_API_KEY;
if (typeof key !== "string" || key.length < 16) throw new Error("MIMO_API_KEY_required_in_process_environment");
const node = process.execPath;
const gatewayPath = new URL("../voice-gateway/dist/main.js", import.meta.url);
const child = spawn(node, [gatewayPath.pathname.replace(/^\//, process.platform === "win32" ? "" : "/")], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    GAMEBUDDY_VOICE_PORT: String(port),
    GAMEBUDDY_VOICE_TOKEN: token,
    GAMEBUDDY_WINDOWS_OUTPUT_DEVICE: outputDevice,
    GAMEBUDDY_MIMO_VOICE: voice,
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
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
try {
  await waitFor(() => stdout.includes("listening on"), 20_000, "gateway_start_timeout");
  const health = await exchange(port, token, {
    type: "health",
    requestId: "health_01",
    voiceProfile: "companion.default",
  });
  const passed = health.type === "health" && health.status === "ready" && health.capabilities?.ready === true;
  console.log(
    JSON.stringify(
      {
        state: passed ? "passed" : "blocked",
        gate: "windows_tts_output",
        selection: outputDevice,
        provider: health.capabilities?.providerId ?? null,
        modelRevision: health.capabilities?.modelRevision ?? null,
        ready: health.capabilities?.ready ?? false,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 2;
} finally {
  child.kill("SIGTERM");
  await Promise.race([once(child, "close"), delay(5_000)]);
  if (!child.killed) child.kill("SIGKILL");
}

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing_${name.slice(2)}`);
  }
  if (i + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[i + 1];
}
async function exchange(port, token, request) {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  let buffer = "";
  const queue = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const value = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(value);
        else queue.push(value);
      } catch {
        socket.destroy(new Error("invalid_gateway_response"));
      }
    }
  });
  const next = () =>
    queue.length > 0
      ? Promise.resolve(queue.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("gateway_health_timeout")), 8_000);
          waiters.push({
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
          });
        });
  await once(socket, "connect");
  socket.write(`${JSON.stringify({ type: "hello", token, protocolVersion: 1, requestId: "hello_01" })}\n`);
  const hello = await next();
  if (hello.type !== "hello_ack") throw new Error("voice_gateway_authentication_failed");
  socket.write(`${JSON.stringify(request)}\n`);
  const health = await next();
  socket.destroy();
  return health;
}
async function waitFor(predicate, timeoutMs, reason) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (stderr.length > 0) throw new Error("gateway_start_failed");
    await delay(50);
  }
  throw new Error(reason);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
