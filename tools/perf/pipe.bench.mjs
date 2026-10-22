/**
 * The named pipe's length-prefixed frame, encoded and decoded on every message.
 *
 * `NamedPipeTransport` is the only wire between the Host and the Stardew Mod, and it frames every
 * message itself: `serializeBounded` -> 4-byte length prefix -> socket, then accumulate -> length
 * check -> utf8 decode. A snapshot and a hello travel the same code and differ only in how many
 * bytes go through it, so both are measured - a decoding regression that only shows up on a full
 * snapshot is the one a small frame hides.
 *
 * The op is one frame round trip against a peer that speaks the wire format (`LocalPipeBridge.cs`
 * on the Mod side does the same): the transport encodes the outgoing frame, the peer writes it
 * back, and the transport decodes the frame that comes in. The receive side's JSON parse is part
 * of the op because that is what the Host's message handler does with the frame it is handed.
 */
import { createServer } from "node:net";
import test from "node:test";

import { loadHostModule, measure, report } from "./harness.mjs";

const CASE = "pipe.frame";

const { NamedPipeTransport } = await loadHostModule("named-pipe.js");

/** `MAX_MESSAGE_BYTES` is 128 KiB; the large frame is a snapshot-sized quarter of it. */
const SIZES = Object.freeze([
  Object.freeze({ size: "small", bodyBytes: 128 }),
  Object.freeze({ size: "large", bodyBytes: 32 * 1024 }),
]);

/** A peer that echoes every frame it reads, framed exactly as the transport expects. */
function echoServer() {
  return createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        const header = Buffer.allocUnsafe(4);
        header.writeInt32LE(payload.byteLength, 0);
        socket.write(Buffer.concat([header, payload]));
      }
    });
  });
}

for (const { size, bodyBytes } of SIZES) {
  test(`${CASE} ${size}`, { timeout: 120_000 }, async () => {
    const pipeName = `gamebuddy_perf_${process.pid}_${size}`;
    let peer;
    const server = echoServer();
    server.on("connection", (socket) => {
      peer = socket;
    });
    await new Promise((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, resolve).once("error", reject));
    const transport = await NamedPipeTransport.connect(pipeName);
    try {
      const payload = { type: "snapshot", body: "x".repeat(bodyBytes) };
      const frameJson = JSON.stringify(payload);
      let settleEcho = () => {};
      transport.onMessage((json) => {
        if (json.length !== frameJson.length) throw new Error("perf_case_pipe_frame_mismatch");
        JSON.parse(json);
        settleEcho();
      });
      const result = await measure({
        id: CASE,
        size,
        run: () => {
          const echo = new Promise((resolve) => {
            settleEcho = resolve;
          });
          transport.send(payload);
          return echo;
        },
      });
      report({ ...result, detail: { frameBytes: Buffer.byteLength(frameJson, "utf8") } });
    } finally {
      transport.close();
      peer?.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
}
