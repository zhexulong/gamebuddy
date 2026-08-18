import assert from "node:assert/strict";
import test from "node:test";
import { writePortfolioFrame, type PortfolioFrameWriter } from "./portfolio-transport.js";

test("frame writer treats false as backpressure and resolves on callback success", async () => {
  let callback!: (error?: Error | null) => void;
  const writer: PortfolioFrameWriter = {
    write(frame, complete) {
      assert.deepEqual([...frame], [1, 2, 3]);
      callback = complete;
      return false;
    },
  };
  const pending = writePortfolioFrame(writer, Buffer.from([1, 2, 3]));
  callback();
  await pending;
});

test("frame writer rejects callback errors and synchronous write throws", async () => {
  const callbackError = new Error("local_write_failure");
  await assert.rejects(
    () => writePortfolioFrame({ write: (_frame, complete) => (complete(callbackError), true) }, Buffer.alloc(0)),
    /local_write_failure/,
  );
  await assert.rejects(
    () => writePortfolioFrame({ write: () => { throw new Error("synchronous_write_failure"); } }, Buffer.alloc(0)),
    /synchronous_write_failure/,
  );
});
