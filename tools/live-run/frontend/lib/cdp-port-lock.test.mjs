// The CDP port lock's cases, each one a failure this kit actually hit: a foreign browser answering the
// port, a dead holder whose browser is still there, a stale lock with nothing on the port, a live holder
// another run must be refused BY NAME, and a live holder whose run directory is read from its own command
// line. No browser and no game are needed - `cdpEndpointAnswers` reads `/json/version`, so an HTTP server
// stands in for Edge, and a bare `node -e` process stands in for the launch driver.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireCdpPortLock, cdpPortLockDir, describeOwner, owningRunDir } from "./cdp-port-lock.mjs";

const ports = { foreign: 9409, dead: 9408, stale: 9407, held: 9406, named: 9411 };

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
      () => acquireCdpPortLock({ port: ports.foreign, waitMs: 0 }),
      /cdp_port_held_by_pid:\d+:unattributed/,
    );
  } finally {
    browser.close();
  }
});

test("a dead holder whose browser is still on the port fails closed instead of joining it", async () => {
  staleLock(ports.dead, 999_999);
  const browser = await fakeBrowser(ports.dead);
  try {
    await assert.rejects(
      () => acquireCdpPortLock({ port: ports.dead, waitMs: 0 }),
      (error) => {
        assert.match(String(error?.message), /cdp_port_held_by_pid:\d+:/);
        assert.match(
          String(error?.message),
          /the lock's holder pid 999999 \(started [^)]+\) is gone but its browser still answers/,
        );
        return true;
      },
    );
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

test(
  "a live holder is refused immediately, and the refusal names its pid and its run directory",
  { timeout: 60_000 },
  async () => {
    // The fake holder is the shape the real orphan had: a process that binds the port and stays alive. Its
    // command line carries `--user-data-dir=<stage>/browser-profile`, which is what the refusal reads.
    const stage = mkdtempSync(join(tmpdir(), "gb-cdp-holder-"));
    mkdirSync(join(stage, "browser-profile"), { recursive: true });
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `require("node:http").createServer((request, response) => response.end()).listen(${ports.named}, "127.0.0.1"); setInterval(() => {}, 1000);`,
        // `--` keeps Node from reading the flag as one of its own options: the holder's command line has
        // to carry the profile flag, which is the fact the refusal reads.
        "--",
        `--user-data-dir=${join(stage, "browser-profile")}`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 700));
      staleLock(ports.named, holder.pid);
      const startedAt = Date.now();
      const error = await acquireCdpPortLock({ port: ports.named }).then(
        () => null,
        (failure) => failure,
      );
      const elapsedMs = Date.now() - startedAt;
      assert.notEqual(error, null, "the held port must be refused");
      const expected = `cdp_port_held_by_pid:${holder.pid}:${stage}`;
      assert.ok(
        String(error.message).startsWith(`${expected}:`),
        `the refusal names the holder and its run directory; got: ${String(error.message).slice(0, 300)}`,
      );
      assert.equal(error.code, expected, "the code IS the pid and the run directory");
      assert.match(String(error.message), /refused immediately \(wait budget 0s\)/);
      assert.match(String(error.message), new RegExp(`taskkill /PID ${holder.pid} /T /F`, "u"));
      assert.ok(elapsedMs < 20_000, `no silent wait: refused in ${elapsedMs}ms`);
    } finally {
      holder.kill("SIGKILL");
      forgetStaleLock(ports.named);
      rmSync(stage, { recursive: true, force: true });
    }
  },
);

test("an explicit wait prints the budget and still fails with the holder named", async () => {
  const held = await acquireCdpPortLock({ port: ports.held, waitMs: 2_000 });
  const said = [];
  try {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(new URL("./cdp-port-lock.mjs", import.meta.url).href)}).then(async (mod) => {
           try {
             await mod.acquireCdpPortLock({ port: ${ports.held}, waitMs: 3_000, say: (m) => console.log(m) });
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
    assert.match(output, new RegExp(`is held by pid ${process.pid} \\(run `, "u"), "the waiting run names the holder");
    assert.match(output, /waiting up to 3s for it to finish/, "and prints the whole budget");
    assert.match(output, /cdp_port_held_by_pid:\d+:/, "and fails with the holder still named");
    assert.match(output, /waited \d+s of a 3s budget/);
    assert.doesNotMatch(output, /CLAIMED_WHILE_HELD/, "it never claims the port out from under the holder");
    assert.match(describeOwner({ pid: process.pid, startedAtMs: Date.now() }), /pid \d+/);
  } finally {
    held.release();
  }
});

test("the run directory is read from the holder's own command line, and only when it exists", () => {
  const stage = mkdtempSync(join(tmpdir(), "gb-cdp-owning-"));
  try {
    const profile = join(stage, "browser-profile");
    mkdirSync(profile, { recursive: true });
    // The browser: the profile flag is the run directory's own child.
    assert.equal(owningRunDir(`msedge.exe --remote-debugging-port=9341 --user-data-dir=${profile} https://x`), stage);
    // The launch driver: the run config argument is inside `<stage>/state`.
    mkdirSync(join(stage, "state"), { recursive: true });
    writeFileSync(join(stage, "state", "run.json"), "{}\n", "utf8");
    assert.equal(owningRunDir(`node.exe E:\\kit\\phases\\launch.mjs ${join(stage, "state", "run.json")}`), stage);
    // A path with a space that nobody quoted splits into tokens; the joins are tried and the one that
    // exists wins, so a truncated directory is never reported.
    assert.equal(owningRunDir(`msedge.exe --user-data-dir=${join(stage, "no such profile")}`), null);
    const spacedStage = mkdtempSync(join(tmpdir(), "gb cdp owning "));
    try {
      mkdirSync(join(spacedStage, "browser-profile"), { recursive: true });
      assert.equal(
        owningRunDir(`msedge.exe --user-data-dir=${join(spacedStage, "browser-profile")} --no-first-run`),
        spacedStage,
      );
    } finally {
      rmSync(spacedStage, { recursive: true, force: true });
    }
    assert.equal(owningRunDir("node.exe -e something"), null);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("the port is claimed before anything is launched", () => {
  // The refusal is only free of a build and a browser because the claim comes first: `launch.mjs` must
  // reach `acquireCdpPortLock` before it imports the launcher or spawns the browser.
  const source = readFileSync(new URL("../phases/launch.mjs", import.meta.url), "utf8");
  const claim = source.indexOf("acquireCdpPortLock");
  const importLauncher = source.indexOf("await import(pathToFileURL(launcherPath).href)");
  const spawnBrowser = source.indexOf("run.edgeExe");
  assert.ok(claim >= 0 && importLauncher > claim, "the port is claimed before the launcher is imported");
  assert.ok(spawnBrowser > claim, "the port is claimed before Edge is spawned");
});
