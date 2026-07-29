import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { NamedPipeTransport } from "./named-pipe.js";

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
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
  await new Promise<void>((resolvePromise, reject) => server.listen(pipePath, () => resolvePromise()).once("error", reject));
  try {
    const transport = await NamedPipeTransport.connect(pipeName);
    const messages: string[] = [];
    transport.onMessage((message) => messages.push(message));
    transport.send({ hello: "world" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    assert.deepEqual(messages, [JSON.stringify({ acknowledgement: true })]);
    transport.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});
