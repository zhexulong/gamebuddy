import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { NamedPipeTransport } from "./named-pipe.js";

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
}

test("named-pipe transport uses bounded length-prefixed JSON frames", async () => {
  const pipeName = `gamebuddy_test_${process.pid}_${Date.now()}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  let peer: Socket | undefined;
  const server = createServer((socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength < 4) return;
      const length = buffer.readInt32LE(0);
      if (buffer.byteLength < 4 + length) return;
      const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      assert.deepEqual(request, { hello: "world" });
      const payload = Buffer.from(JSON.stringify({ acknowledgement: true }), "utf8");
      const header = Buffer.allocUnsafe(4);
      header.writeInt32LE(payload.byteLength, 0);
      socket.write(Buffer.concat([header, payload]));
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(pipePath, () => resolvePromise()).once("error", reject),
  );
  try {
    const transport = await NamedPipeTransport.connect(pipeName);
    const messages: string[] = [];
    const stages: string[] = [];
    transport.onMessage((message) => messages.push(message));
    transport.onFrameStage((stage) => stages.push(stage));
    transport.send({ hello: "world" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    assert.deepEqual(messages, [JSON.stringify({ acknowledgement: true })]);
    assert.equal(stages.filter((stage) => stage === "pipe_write_completed").length, 1);
    assert.equal(stages.filter((stage) => stage === "pipe_write_failed").length, 0);
    transport.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});


test("named-pipe transport reports only fixed framing stages across fragmented input", async () => {
  const pipeName = `gamebuddy_frame_stage_${process.pid}_${Date.now()}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  let peer: Socket | undefined;
  const server = createServer((socket) => {
    peer = socket;
    const payload = Buffer.from(JSON.stringify({ snapshot: true }), "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeInt32LE(payload.byteLength, 0);
    socket.write(header.subarray(0, 2));
    setImmediate(() => {
      socket.write(Buffer.concat([header.subarray(2), payload.subarray(0, 1)]));
      setImmediate(() => socket.write(payload.subarray(1)));
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(pipePath, () => resolvePromise()).once("error", reject),
  );
  try {
    const transport = await NamedPipeTransport.connect(pipeName);
    const stages: string[] = [];
    const messages: string[] = [];
    transport.onFrameStage((stage) => stages.push(stage));
    transport.onMessage((message) => messages.push(message));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.deepEqual(messages, [JSON.stringify({ snapshot: true })]);
    assert.ok(stages.filter((stage) => stage === "pipe_bytes_received").length >= 2);
    assert.ok(stages.filter((stage) => stage === "pipe_frame_header_accepted").length >= 1);
    assert.equal(stages.filter((stage) => stage === "pipe_frame_payload_complete").length, 1);
    assert.equal(stages.filter((stage) => stage === "pipe_frame_dispatched").length, 1);
    assert.ok(stages.every((stage) => /^pipe_(?:bytes_received|frame_(?:header_accepted|payload_complete|dispatched))$/.test(stage)));
    transport.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});
