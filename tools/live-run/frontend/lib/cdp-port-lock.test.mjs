// The CDP port lock's four cases, each one a failure this kit actually hit: a foreign browser answering the
// port, a dead holder whose browser is still there, a stale lock with nothing on the port, and a live holder
// a second run must wait for by name rather than join. No browser and no game are needed - `cdpEndpointAnswers`
// reads `/json/version`, so an HTTP server stands in for Edge.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { acquireCdpPortLock, cdpPortLockDir, describeOwner } from "./cdp-port-lock.mjs";

const ports = { foreign: 9409, dead: 9408, stale: 9407, held: 9406 };

const fakeBrowser = (port) =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      if (request.url === "/json/version") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ Browser: "fake" }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

const staleLock = (port, pid) => {
  mkdirSync(cdpPortLockDir(port), { recursive: true });
  writeFileSync(`${cdpPortLockDir(port)}/owner.json`, `${JSON.stringify({ pid, startedAtMs: Date.now() })}\n`, "utf8");
};

// The stale-lock cases exist to make the lock refuse, and the lock cannot clean up one it never claimed - so the
// test does. Without this, every run of the suite leaves a `cdp-*.lock` directory in the kit's `.tmp`.
const forgetStaleLock = (port) => {
  rmSync(cdpPortLockDir(port), { recursive: true, force: true });
};

test("a browser answering the port that no run holds fails closed and names it", async () => {
  const browser = await fakeBrowser(ports.foreign);
  try {
    await assert.rejects(
      () => acquireCdpPortLock({ port: ports.foreign, waitMs: 500 }),
      /cdp_port_held_by_foreign_browser/,
    );
  } finally {
    browser.close();
  }
});

test("a dead holder whose browser is still on the port fails closed instead of joining it", async () => {
  staleLock(ports.dead, 999_999);
  const browser = await fakeBrowser(ports.dead);
  try {
    await assert.rejects(() => acquireCdpPortLock({ port: ports.dead, waitMs: 500 }), /cdp_port_held_by_dead_holder/);
  } finally {
    browser.close();
    forgetStaleLock(ports.dead);
  }
});

test("a stale lock with nothing on the port is reclaimed", async () => {
  staleLock(ports.stale, 999_998);
  const claimed = await acquireCdpPortLock({ port: ports.stale, waitMs: 2_000 });
  try {
    assert.equal(claimed.dir, cdpPortLockDir(ports.stale));
  } finally {
    claimed.release();
  }
});

test("a second run waits by name, then fails with the holder named", async () => {
  const held = await acquireCdpPortLock({ port: ports.held, waitMs: 2_000 });
  const said = [];
  try {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(new URL("./cdp-port-lock.mjs", import.meta.url).href)}).then(async (mod) => {
           try {
             await mod.acquireCdpPortLock({ port: ${ports.held}, waitMs: 5_000, say: (m) => console.log(m) });
             console.log("CLAIMED_WHILE_HELD");
           } catch (error) {
             console.log(String(error?.message ?? error));
           }
         })`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk) => said.push(String(chunk)));
    child.stderr.on("data", (chunk) => said.push(String(chunk)));
    await new Promise((resolve) => child.on("close", resolve));

    const output = said.join("");
    assert.match(output, /is held by pid \d+ \(started/, "the waiting run names the holder");
    assert.match(output, /cdp_port_lock_timeout/, "and fails with the holder still named");
    assert.doesNotMatch(output, /CLAIMED_WHILE_HELD/, "it never claims the port out from under the holder");
    assert.match(describeOwner({ pid: process.pid, startedAtMs: Date.now() }), /pid \d+/);
  } finally {
    held.release();
  }
});
