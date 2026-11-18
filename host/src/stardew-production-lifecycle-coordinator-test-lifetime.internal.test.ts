/**
 * A test file that never returns is worse than one that fails: it prints no summary, so every test
 * after it is hidden and the only reading a reader gets is silence. This file is where that class
 * is either caught or left alive.
 *
 * The instance it was written against: `createAdmissionBroker` opened a real loopback HTTP server
 * and only then ran the bootstrap handshake, while its teardown lived in the object it returned at
 * the END. A handshake that failed - a refused bootstrap answers something other than 200, which a
 * merged coordinator did for attempt 1 - left the socket listening with no owner at all: the caller
 * never received a broker to close, no `finally` could reach it, the fixture registry never saw it,
 * and the file printed its tests and then never returned. `--test-timeout` cannot end that, because
 * it bounds a test BODY rather than a leaked handle.
 *
 * Two readings:
 *
 *  1. the MECHANISM - a fixture whose own bootstrap is refused throws, and leaves no listening
 *     server behind;
 *  2. the CLASS - every test file that can stand up one of those sockets is run as its own bounded
 *     process, and one that does not terminate with a summary is named.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFixture,
  installLifecycleTestHooks,
  withWindowsPlatform,
} from "./stardew-production-lifecycle-coordinator.test-support.js";

installLifecycleTestHooks();

const HOST_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOT = join(HOST_ROOT, "src");
const COMPILED_ROOT = join(HOST_ROOT, "dist-test");
/** The one module that owns a loopback socket for the fixture family. */
const SUPPORT_MODULE = "stardew-production-lifecycle-coordinator.test-support.ts";

/**
 * How long one file may take before it is called hung. Every file in today's population finishes in
 * a few seconds, so this is two orders of magnitude of margin; the reading below prints the bound
 * and the slowest file it actually saw, so a bound that has drifted too tight is visible instead of
 * being read as a hang.
 */
const FILE_BOUND_MS = 120_000;

/** Every file under a directory, as `host/src`-relative `/`-separated paths. */
function sourceFiles(directory: string = SOURCE_ROOT, prefix = ""): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const file = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...sourceFiles(join(directory, entry.name), file));
      continue;
    }
    if (file.endsWith(".ts")) files.push(file);
  }
  return files;
}

/**
 * The EXPORTED names of `source` whose body reaches a `.listen(`, following one call at a time.
 *
 * Derived rather than listed: the population below is "a file that can stand up one of these
 * sockets", and the authority for that is the module that opens them. A fixture entry point added
 * tomorrow is in the population the moment it is written, and a module whose socket goes away
 * yields an empty set - which the gate below refuses to pass, rather than reporting zero files.
 */
function socketReachingExports(source: string): ReadonlySet<string> {
  const starts = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/gmu)];
  const bodies = starts.map((match, index) =>
    Object.freeze({ name: match[1]!, body: source.slice(match.index, starts[index + 1]?.index ?? source.length) }),
  );
  const reaching = new Set(bodies.filter(({ body }) => /\.listen\(/u.test(body)).map(({ name }) => name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, body } of bodies) {
      if (reaching.has(name)) continue;
      if ([...reaching].every((other) => !new RegExp(`\\b${other}\\(`, "u").test(body))) continue;
      reaching.add(name);
      grew = true;
    }
  }
  const exported = new Set([...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/gu)].map((match) => match[1]!));
  for (const group of source.matchAll(/export\s*\{([^}]*)\}/gu))
    for (const entry of group[1]!.split(","))
      exported.add(
        entry
          .trim()
          .split(/\s+as\s+/u)
          .pop() ?? "",
      );
  return new Set([...reaching].filter((name) => exported.has(name)));
}

/**
 * The files that can stand up a loopback socket: every test file whose source names one of the
 * support module's socket-reaching exports. This file is excluded from its own population - it is
 * the one that walks them, and a gate that ran itself would never return either.
 */
function terminationPopulation(relativeFiles: readonly string[], self: string): readonly string[] {
  const entryPoints = socketReachingExports(readFileSync(join(SOURCE_ROOT, SUPPORT_MODULE), "utf8"));
  if (entryPoints.size === 0) return [];
  return relativeFiles.filter(
    (file) =>
      file !== self &&
      file.endsWith(".test.ts") &&
      [...entryPoints].some((name) =>
        new RegExp(`\\b${name}\\b`, "u").test(readFileSync(join(SOURCE_ROOT, file), "utf8")),
      ),
  );
}

/** The reporter's own totals line: the one thing a file that terminated always printed. */
const SUMMARY = /(?:^|\n)ℹ tests \d+/u;

/** The child's last non-empty line, bounded: a finding has to say what the file did instead. */
function lastLine(output: string): string {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim() !== "");
  const tail = lines.at(-1)?.trim() ?? "<no output>";
  return tail.length > 200 ? `${tail.slice(0, 200)}…` : tail;
}

type Reading = Readonly<{
  file: string;
  output: string;
  terminated: boolean;
  elapsedMs: number;
  findings: readonly string[];
}>;

/**
 * One file as its own process, bounded, then read for a summary.
 *
 * It is executed DIRECTLY rather than through `node --test`: the test-runner coordinator spawns a
 * child per file, so killing the coordinator at the bound would leave that child - the very handle
 * this gate exists for - running and unowned. One process is one kill. The property is unchanged:
 * the reporter prints the same summary whether the file is entered directly or by the coordinator.
 *
 * The suite's `compiled-test-bootstrap` preload is deliberately not passed: it binds the release
 * lock reclaimer, which exists only under a built generation, so requiring it here would make this
 * gate's reading a fact about the artifact instead of about whether the file returns. Every file in
 * the population installs its own test reclaimer through `installLifecycleTestHooks`.
 */
async function runBounded(file: string, boundMs: number): Promise<Reading> {
  const startedAt = Date.now();
  // `NODE_TEST_CONTEXT` is set by the test-runner coordinator on ITS children and is inherited by
  // grandchildren, where it switches the reporter to the runner's private serialized protocol: the
  // child then writes V8 frames instead of the summary a reader sees, and this gate would report a
  // file as unreadable when the only thing wrong was how it was started.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [file], {
    cwd: HOST_ROOT,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: string): void => {
    output = `${output}${chunk}`.slice(-16_000);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), boundMs);
  });
  const terminated = await Promise.race([closed.then(() => true), bound]);
  if (timer !== undefined) clearTimeout(timer);
  if (!terminated) {
    child.kill("SIGKILL");
    await closed;
  }
  const findings: string[] = [];
  if (!terminated) findings.push(`never_returned:${file}:no summary within ${boundMs}ms`);
  else if (!SUMMARY.test(output)) findings.push(`terminated_without_a_summary:${file}:last=${lastLine(output)}`);
  return Object.freeze({
    file,
    output,
    terminated,
    elapsedMs: Date.now() - startedAt,
    findings: Object.freeze(findings),
  });
}

/** Every file, in order, as its own bounded process - and what the set of them says. */
async function terminationReading(
  files: readonly string[],
  boundMs: number = FILE_BOUND_MS,
): Promise<
  Readonly<{ examined: number; terminated: number; hung: number; slowestMs: number; findings: readonly string[] }>
> {
  const readings: Reading[] = [];
  for (const file of files) readings.push(await runBounded(file, boundMs));
  return Object.freeze({
    examined: readings.length,
    terminated: readings.filter((reading) => reading.terminated).length,
    hung: readings.filter((reading) => !reading.terminated).length,
    slowestMs: readings.reduce((slowest, reading) => Math.max(slowest, reading.elapsedMs), 0),
    findings: Object.freeze(readings.flatMap((reading) => reading.findings)),
  });
}

/** The listening loopback servers this process currently holds - the handle a hang is made of. */
function listeningServers(): readonly unknown[] {
  const handles = (process as unknown as { _getActiveHandles?(): unknown[] })._getActiveHandles?.() ?? [];
  return handles.filter(
    (handle) =>
      (handle as { constructor?: { name?: string }; listening?: boolean }).constructor?.name === "Server" &&
      (handle as { listening?: boolean }).listening === true,
  );
}

test("a_fixture_whose_bootstrap_is_refused_leaves_no_listening_server", async () => {
  const before = listeningServers().length;
  const realFetch = globalThis.fetch;
  // The real defect's trigger, at the network boundary: a refused bootstrap is exactly what a merged
  // coordinator answered for attempt 1. Neither product nor test-support code is modified by the test.
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.includes("/bootstrap") ? new Response("refused", { status: 409 }) : realFetch(input, init);
  };
  let thrown: unknown;
  try {
    await withWindowsPlatform(async () => {
      await createFixture({});
    });
  } catch (error) {
    thrown = error;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(thrown !== undefined, "a fixture whose bootstrap was refused must refuse, not return half a fixture");
  assert.equal(
    listeningServers().length,
    before,
    "the refused fixture left its loopback server listening, so this file's process can never exit and nothing after it is reported",
  );
});

test("a_test_that_never_returns_hides_the_ones_after_it: every fixture file terminates and prints a summary", async (t) => {
  const population = terminationPopulation(
    sourceFiles(),
    "stardew-production-lifecycle-coordinator-test-lifetime.internal.test.ts",
  );
  // Fail on zero: a population that found no file agrees with itself.
  assert.ok(
    population.length > 0,
    "no test file names a socket-reaching support export, so this gate examined nothing and proves nothing",
  );
  const reading = await terminationReading(population.map((file) => join(COMPILED_ROOT, `${file.slice(0, -3)}.js`)));
  t.diagnostic(
    `a_test_that_never_returns_hides_the_ones_after_it: files examined ${reading.examined} · terminated ` +
      `${reading.terminated} · hung ${reading.hung} · bound_ms ${FILE_BOUND_MS} · slowest_ms ${reading.slowestMs}`,
  );
  assert.deepEqual(reading.findings, []);
});

/**
 * The falsifier: the same reading over two planted files that differ only in whether the socket they
 * open is closed. If the one that keeps it is not named, the gate above proves nothing.
 */
test("a_test_that_never_returns_hides_the_ones_after_it (falsifier): a file that keeps its server is named", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-termination-gate-"));
  const source = (closeServer: boolean): string =>
    [
      'import { createServer } from "node:http";',
      'import test from "node:test";',
      "const server = createServer((_request, response) => response.end());",
      'await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
      'test("prints a summary", () => {});',
      ...(closeServer ? ["await new Promise((resolve) => server.close(resolve));"] : []),
      "",
    ].join("\n");
  const closed = join(root, "closed.test.mjs");
  const asleep = join(root, "asleep.test.mjs");
  try {
    await writeFile(closed, source(true), "utf8");
    await writeFile(asleep, source(false), "utf8");
    // Five seconds is not a budget for anything real: the planted file prints its one-line summary
    // within a second, so the only file that reaches this bound is the one that cannot return.
    const reading = await terminationReading([closed, asleep], 5_000);
    t.diagnostic(
      `falsifier: files examined ${reading.examined} · terminated ${reading.terminated} · hung ${reading.hung} · ` +
        reading.findings.join(" | "),
    );
    assert.equal(reading.examined, 2);
    assert.equal(reading.terminated, 1, "the planted file that closed its server terminated");
    assert.equal(reading.hung, 1, "the planted file that kept its server never returned and must be counted as hung");
    assert.match(reading.findings[0]!, /^never_returned:.*asleep\.test\.mjs:no summary within /u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
