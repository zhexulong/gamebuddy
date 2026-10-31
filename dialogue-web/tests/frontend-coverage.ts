/**
 * The mounted zone's coverage seam.
 *
 * Every journey imports `test`/`expect` from here instead of from
 * `@playwright/test`, so Chromium's own V8 coverage of the page under test is
 * collected for the page each journey already drives. That import is the one place
 * a journey opts in, which is why the population is derived rather than listed:
 * `tests/frontend-coverage-gate.test.mjs` reads the journey directory and fails
 * naming any `*.spec.ts` that bypasses it. A journey that bypassed the seam is a
 * journey whose pages nothing measures, and the report would then narrow without
 * saying so.
 *
 * What is collected per test: the V8 functions/ranges of every `/src/**` module the
 * page loaded, plus the set of modules that test touched. Merging is a sum per
 * range tuple - V8 block coverage is a tree of non-overlapping ranges per function
 * and the module text a URL served is identical across the run - and the source
 * comparison below is what keeps that assumption honest: a dev server that served
 * two different builds under one URL would otherwise be summed as one file.
 *
 * The report and the floors are applied once per run by
 * `tests/frontend-coverage-report.mjs` (run from `playwright.config.ts`'s teardown),
 * so the numbers cost one pass over the raw data instead of a report per test.
 *
 * What this cannot see, and the report says so instead of reading a zero: a page a
 * journey opens from a raw `browser.newContext()` is not the `page` fixture, so its
 * statements are not measured. One journey does that today for its Chinese-locale
 * rendering pass.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, type TestInfo, test as base } from "@playwright/test";

export * from "@playwright/test";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rawDirectory = join(PACKAGE_ROOT, "coverage", "raw");

/**
 * `GAMEBUDDY_FRONTEND_COVERAGE=off` turns collection off for a local iteration run.
 * It is not a way to skip the gate: the run then writes no entries, and the teardown
 * refuses the run as unmeasured rather than reading a previous run's numbers.
 */
const collectionEnabled = process.env.GAMEBUDDY_FRONTEND_COVERAGE !== "off";

type Range = { startOffset: number; endOffset: number; count: number };
type FunctionCoverage = { functionName: string; isBlockCoverage: boolean; ranges: Range[] };
type Script = { source: string; functions: Map<string, FunctionCoverage> };

/** One worker process's accumulation, flushed when that worker exits. */
const scripts = new Map<string, Script>();
const moduleTests = new Map<string, Set<string>>();
const journeyTitles = new Set<string>();
let workerIndex = "0";

/** The app's own modules only: a dependency, a probe page or Vite's client is not the product. */
function isSourceModule(url: string) {
  return /^https?:\/\/[^/]+\/src\/[\w./-]+\.(?:ts|tsx)$/u.test(url.split("?")[0]);
}

const signature = (fn: FunctionCoverage) =>
  `${fn.functionName}|${fn.isBlockCoverage ? 1 : 0}|${fn.ranges.map((r) => `${r.startOffset}-${r.endOffset}`).join(",")}`;

function absorb(url: string, source: string, functions: FunctionCoverage[]) {
  const existing = scripts.get(url);
  if (existing === undefined) {
    const script: Script = { source, functions: new Map() };
    for (const fn of functions) {
      script.functions.set(signature(fn), {
        functionName: fn.functionName,
        isBlockCoverage: fn.isBlockCoverage,
        ranges: fn.ranges.map((range) => ({ ...range })),
      });
    }
    scripts.set(url, script);
    return;
  }
  if (existing.source !== source) {
    throw new Error(
      `frontend_coverage_source_drift:${url}\n` +
        "  one module URL was served with two different sources in one run, so its ranges cannot be\n" +
        "  summed. Clear the dev server's HMR cache (or restart it) and re-run the zone.",
    );
  }
  for (const fn of functions) {
    const key = signature(fn);
    const merged = existing.functions.get(key);
    if (merged === undefined) {
      existing.functions.set(key, {
        functionName: fn.functionName,
        isBlockCoverage: fn.isBlockCoverage,
        ranges: fn.ranges.map((range) => ({ ...range })),
      });
      continue;
    }
    merged.ranges.forEach((range, index) => {
      range.count += fn.ranges[index].count;
    });
  }
}

function flush() {
  mkdirSync(rawDirectory, { recursive: true });
  const entries = [...scripts].map(([url, script]) => ({
    url,
    source: script.source,
    functions: [...script.functions.values()],
  }));
  // The file name carries the process id because Playwright restarts a worker process
  // after a test failure and hands the RESTART the same index, with fresh module state.
  // One file per index would let the restart's flush overwrite the first process's
  // journeys, and the report would then believe most of the corpus never ran - a floor
  // breach that is really a lost file. The report unions every `worker-*.json`, so one
  // more file is one more union.
  writeFileSync(
    join(rawDirectory, `worker-${workerIndex}-${process.pid}.json`),
    JSON.stringify({
      workerIndex,
      journeys: [...journeyTitles].sort(),
      modules: [...moduleTests].map(([url, tests]) => ({ url, tests: [...tests].sort() })),
      entries,
    }),
  );
}

export const test = base.extend<{ frontendCoverage: void }, { frontendCoverageSink: void }>({
  /** The worker sink: one raw file per worker, written when that worker's last test ends. */
  frontendCoverageSink: [
    async ({}, use: (value: void) => Promise<void>) => {
      await use();
      flush();
    },
    { scope: "worker" },
  ],
  /** The per-test collector: automatic, so no journey mentions coverage anywhere. */
  frontendCoverage: [
    async (
      { page, frontendCoverageSink: _sink }: { page: Page; frontendCoverageSink: void },
      use: (value: void) => Promise<void>,
      testInfo: TestInfo,
    ) => {
      workerIndex = String(testInfo.workerIndex);
      const journey = relative(PACKAGE_ROOT, testInfo.file).split(/[\\/]/u).join("/");
      journeyTitles.add(journey);
      if (!collectionEnabled) {
        await use();
        return;
      }
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      try {
        await use();
      } finally {
        for (const entry of await page.coverage.stopJSCoverage()) {
          const url = entry.url.split("?")[0];
          if (!isSourceModule(url) || entry.source === undefined) continue;
          const module = new URL(url).pathname;
          absorb(module, entry.source, entry.functions as unknown as FunctionCoverage[]);
          const tests = moduleTests.get(module) ?? new Set<string>();
          tests.add(journey);
          moduleTests.set(module, tests);
        }
      }
    },
    { auto: true },
  ],
});
