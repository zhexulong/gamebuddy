import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  formatGameClock,
  formatGameDate,
  formatGameEnvironmentFacts,
  formatGameStamina,
  formatGameWeather,
  reloadMagicContextInRuntimeRoot,
} from "./runtime-core.internal.js";

/**
 * The Magic Context bootstrap owns the runtime's SQLite root, and the extension
 * gives MAGIC_CONTEXT_STORAGE_DIR precedence over the XDG-derived path. So an
 * inherited value - an operator's or a sibling dev agent's - decides the store
 * this runtime opens. Measured on a live composed turn, inheriting one whose
 * migration lane is ahead of this build's schema fence leaves the extension
 * fail-closed, and its guarded context hook then aborts the provider request
 * (`AbortError: This operation was aborted`), terminalizing the turn `failed`
 * with `runtime_unavailable`. The bootstrap must therefore pin the runtime's own
 * root for the whole window it already pins cwd/XDG for.
 */
test("the Magic Context bootstrap pins the runtime's own store over an inherited override", async () => {
  const foreign = join("D:\\foreign", "cortexkit", "magic-context");
  const previous = {
    cwd: process.cwd(),
    data: process.env.XDG_DATA_HOME,
    config: process.env.XDG_CONFIG_HOME,
    storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
  };
  const runtimeCwd = mkdtempSync(join(tmpdir(), "gb-magic-context-root-"));
  let observed:
    | Readonly<{ cwd: string; data: string | undefined; config: string | undefined; storage: string | undefined }>
    | undefined;
  const loader = {
    reload: async (): Promise<void> => {
      observed = Object.freeze({
        cwd: process.cwd(),
        data: process.env.XDG_DATA_HOME,
        config: process.env.XDG_CONFIG_HOME,
        storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
      });
    },
  };
  try {
    process.env.MAGIC_CONTEXT_STORAGE_DIR = foreign;
    await reloadMagicContextInRuntimeRoot(loader as unknown as DefaultResourceLoader, runtimeCwd);
    assert.equal(observed?.storage, join(runtimeCwd, "data", "cortexkit", "magic-context"));
    assert.notEqual(observed?.storage, foreign);
    assert.equal(observed?.data, join(runtimeCwd, "data"));
    assert.equal(observed?.config, join(runtimeCwd, "config"));
    assert.equal(observed?.cwd, runtimeCwd);
    // The surrounding process's own value is restored, never consumed.
    assert.equal(process.env.MAGIC_CONTEXT_STORAGE_DIR, foreign);
    assert.equal(process.cwd(), previous.cwd);
  } finally {
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous.data;
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.storage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = previous.storage;
    process.chdir(previous.cwd);
    rmSync(runtimeCwd, { recursive: true, force: true });
  }
});

/**
 * The other half of that pin: a runtime that had no inherited override must not
 * leave one behind, otherwise the next runtime in this process - and any child
 * it spawns - would inherit this runtime's store as its own override.
 */
test("the Magic Context bootstrap leaves no storage override behind when none was inherited", async () => {
  const previousStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
  const previousCwd = process.cwd();
  const runtimeCwd = mkdtempSync(join(tmpdir(), "gb-magic-context-root-"));
  const loader = { reload: async (): Promise<void> => undefined };
  try {
    delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    await reloadMagicContextInRuntimeRoot(loader as unknown as DefaultResourceLoader, runtimeCwd);
    assert.equal(process.env.MAGIC_CONTEXT_STORAGE_DIR, undefined);
  } finally {
    if (previousStorage !== undefined) process.env.MAGIC_CONTEXT_STORAGE_DIR = previousStorage;
    process.chdir(previousCwd);
    rmSync(runtimeCwd, { recursive: true, force: true });
  }
});

test("formatGameClock renders Native 24h clock as 12h with period", () => {
  assert.equal(formatGameClock(600), "6:00 AM");
  assert.equal(formatGameClock(1200), "12:00 PM");
  assert.equal(formatGameClock(1700), "5:00 PM");
  assert.equal(formatGameClock(0), "12:00 AM");
  assert.equal(formatGameClock(1930), "7:30 PM");
  assert.equal(formatGameClock(2600), "2:00 AM");
});

test("formatGameClock rejects out-of-range clocks", () => {
  assert.equal(formatGameClock(-5), "");
  assert.equal(formatGameClock(9999), "");
  assert.equal(formatGameClock(60123), "");
  assert.equal(formatGameClock(18.5), "");
  assert.equal(formatGameClock(Number.NaN), "");
});

test("formatGameDate localizes season name and order", () => {
  assert.equal(formatGameDate(1, 0, 1, true), "1年第1天 春季");
  assert.equal(formatGameDate(19, 0, 1, true), "1年第19天 春季");
  assert.equal(formatGameDate(1, 1, 1, true), "1年第1天 夏季");
  assert.equal(formatGameDate(1, 2, 2, true), "2年第1天 秋季");
  assert.equal(formatGameDate(1, 3, 3, true), "3年第1天 冬季");
  assert.equal(formatGameDate(1, 0, 1, false), "Year 1, Day 1 of Spring");
  assert.equal(formatGameDate(28, 2, 4, false), "Year 4, Day 28 of Fall");
});

test("formatGameDate falls back to the raw index for unknown seasons", () => {
  const v = formatGameDate(1, 7, 1, true);
  assert.match(v, /7/);
});

test("formatGameWeather maps stable token to localized human phrase", () => {
  assert.equal(formatGameWeather("sunny", true), "天气：晴天");
  assert.equal(formatGameWeather("rain", true), "天气：雨天");
  assert.equal(formatGameWeather("snow", true), "天气：下雪");
  assert.equal(formatGameWeather("lightning", true), "天气：雷雨");
  assert.equal(formatGameWeather("debris", true), "天气：风沙");
  assert.equal(formatGameWeather("unknown", true), "天气：未知天气");
  assert.equal(formatGameWeather("sunny", false), "weather: sunny");
  assert.equal(formatGameWeather("rain", false), "weather: rainy");
  assert.equal(formatGameWeather("lightning", false), "weather: thunderstorm");
});

test("formatGameWeather passes through unknown tokens rather than guessing", () => {
  assert.equal(formatGameWeather("blizzard", true), "天气：blizzard");
  assert.equal(formatGameWeather("blizzard", false), "weather: blizzard");
});

test("formatGameEnvironmentFacts carries the actor's current stamina, verbatim", () => {
  const facts = formatGameEnvironmentFacts(
    {
      timeOfDay: 1700,
      dayOfMonth: 19,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
      location: "Farm",
      stamina: 270,
      exhausted: false,
    },
    false,
  );
  assert.equal(facts, "5:00 PM；Year 1, Day 19 of Spring；weather: sunny；location: Farm；stamina: 270");
});

test("formatGameEnvironmentFacts localizes stamina and marks persistent fatigue", () => {
  const facts = formatGameEnvironmentFacts(
    {
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
      weather: "rain",
      location: "Farm",
      stamina: 12,
      exhausted: true,
    },
    true,
  );
  assert.equal(facts, "6:00 AM；1年第1天 春季；天气：雨天；位置: Farm；体力: 12（已疲惫）");
});

test("formatGameEnvironmentFacts omits stamina when the snapshot does not carry it", () => {
  const facts = formatGameEnvironmentFacts(
    { timeOfDay: 1700, dayOfMonth: 19, seasonIndex: 0, year: 1, weather: "sunny", location: "Farm" },
    false,
  );
  assert.equal(facts, "5:00 PM；Year 1, Day 19 of Spring；weather: sunny；location: Farm");
  assert.ok(!facts.includes("stamina"));
});

test("formatGameEnvironmentFacts omits stamina rather than defaulting a non-finite reading", () => {
  const facts = formatGameEnvironmentFacts(
    {
      timeOfDay: 1700,
      dayOfMonth: 19,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
      location: "Farm",
      stamina: Number.NaN,
      exhausted: false,
    },
    false,
  );
  assert.equal(facts, "5:00 PM；Year 1, Day 19 of Spring；weather: sunny；location: Farm");
  assert.ok(!facts.includes("stamina"));
});

test("formatGameStamina publishes the native value, including a drained negative or fractional one", () => {
  assert.equal(formatGameStamina(-15, false, false), "stamina: -15");
  assert.equal(formatGameStamina(270.5, false, false), "stamina: 270.5");
  assert.equal(formatGameStamina(undefined, false, false), "");
  assert.equal(formatGameStamina(Number.NaN, true, false), "");
});
