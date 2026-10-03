import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatGameClock,
  formatGameDate,
  formatGameWeather,
} from "./runtime-core.internal.js";

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
