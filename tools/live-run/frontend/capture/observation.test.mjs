/*
 * red-proof: inject  the tests below were each run against a deliberately broken reader before they
 * were accepted, and the break each one catches is named in its own message:
 *
 *   switchDurations     returning `durationMs: 0` for a `done` with no `start` (the shape Back and
 *                       Escape produce) reddens "a done with no start is not a switch whose duration is
 *                       zero".
 *   injectionFacts      `{ present: false, bytes: 0 }` for a block that is not there reddens "an absent
 *                       block is absence, not a zero-byte block", and treating a missing capture as an
 *                       empty request list reddens "no capture is not an empty injection".
 *                       Attributing bodies by their index in the file reddens "each body is read
 *                       against its own turn id", which is the defect this reader was rebuilt for.
 *   prefixes            renaming the product's switch prefix reddens "the kit reads the marks the
 *                       product emits".
 *
 * The paint cases are the original red-proof and are unchanged: see the file's own history for why LCP
 * is a field this reader must not claim.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { injectionFacts, observe, readCapturedRequests, readPaintFacts, switchDurations } from "./observation.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

/**
 * A page whose Performance API answers exactly the entries we hand it.
 *
 * `document` is stubbed too, because `observe` reads DOM size from the same page and a test that only
 * wants the INJECTION lines should not have to pretend to be a browser for the other four sections.
 */
function fakePage(entries) {
  return {
    evaluate(fn, ...args) {
      const originalPerformance = globalThis.performance;
      const originalDocument = globalThis.document;
      globalThis.performance = {
        getEntriesByType(type) {
          return entries.filter((entry) => entry.entryType === type);
        },
      };
      globalThis.document = { getElementsByTagName: () => ({ length: 7 }) };
      try {
        return Promise.resolve(fn(...args));
      } finally {
        globalThis.performance = originalPerformance;
        globalThis.document = originalDocument;
      }
    },
  };
}

test("paint facts report first paint and FCP, and claim no LCP", async () => {
  const page = fakePage([
    { entryType: "paint", name: "first-paint", startTime: 428.4 },
    { entryType: "paint", name: "first-contentful-paint", startTime: 436.9 },
  ]);
  const paint = await readPaintFacts(page);
  assert.equal(paint.firstPaintMs, 428, "first paint is rounded to whole milliseconds");
  assert.equal(paint.firstContentfulPaintMs, 437);
  assert.equal(
    "largestContentfulPaintMs" in paint,
    false,
    "LCP needs an observer installed before navigation; this kit does not install one, so the field must be absent rather than permanently null",
  );
});

test("a page with content and no LCP entry still reports paint facts", async () => {
  /* This is the real shape: content painted, and the LCP list is empty because nothing subscribed. */
  const page = fakePage([{ entryType: "paint", name: "first-contentful-paint", startTime: 500 }]);
  const paint = await readPaintFacts(page);
  assert.equal(paint.firstContentfulPaintMs, 500);
  assert.equal("largestContentfulPaintMs" in paint, false);
});

test("a missing paint entry is null, not zero", async () => {
  const paint = await readPaintFacts(fakePage([]));
  assert.equal(paint.firstPaintMs, null, "0 would be a measurement; absence is the truth");
  assert.equal(paint.firstContentfulPaintMs, null);
});

/* ---------- SWITCHES ---------- */

const start = (surface, at) => ({ name: `gamebuddy:switch:${surface}:start`, at });
const done = (surface, at) => ({ name: `gamebuddy:switch:${surface}:done`, at });

test("a switch's duration is the gap between its own two marks", () => {
  const pairs = switchDurations([start("game", 100), done("game", 142.5)]);
  assert.deepEqual(pairs, [{ surface: "game", startMs: 100, doneMs: 142.5, durationMs: 42.5 }]);
});

test("a done with no start is not a switch whose duration is zero", () => {
  /* Back and Escape move the history entry: the browser switched the surface, nobody pressed an entry. */
  const pairs = switchDurations([done("chat", 300)]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].startMs, null, "no selection happened, so there is no start to report");
  assert.equal(
    pairs[0].durationMs,
    null,
    "0 would describe an instantaneous switch that was never timed; absence is the truth",
  );
});

test("a start that never committed has no duration", () => {
  const pairs = switchDurations([start("settings", 10)]);
  assert.deepEqual(pairs, [{ surface: "settings", startMs: 10, doneMs: null, durationMs: null }]);
});

test("switches are paired per surface, in page order, and interleaved surfaces do not borrow each other's marks", () => {
  const pairs = switchDurations([start("game", 10), start("chats", 20), done("chats", 35), done("game", 60)]);
  assert.deepEqual(
    pairs.map((pair) => [pair.surface, pair.durationMs]),
    [
      ["chats", 15],
      ["game", 50],
    ],
    "each done closes the start of ITS surface, not the oldest open one",
  );
});

test("a second start for a surface leaves the first switch reported as unfinished", () => {
  const pairs = switchDurations([start("game", 10), start("game", 30), done("game", 50)]);
  assert.deepEqual(
    pairs.map((pair) => [pair.startMs, pair.doneMs, pair.durationMs]),
    [
      [10, null, null],
      [30, 50, 20],
    ],
    "a switch whose done was overwritten did not finish; reporting its duration as the later gap would invent one",
  );
});

/* ---------- INJECTION ---------- */

const systemPrompt = (lines) => ({ messages: [{ role: "system", content: lines.join("\n") }] });

const AUTHORED = [
  '<gamebuddy-authored-context version="v2">',
  '<gamebuddy-authored-source kind="lorebook_constant">',
  "农场",
  "</gamebuddy-authored-source>",
  '<gamebuddy-authored-source kind="persona">',
  "她叫艾米丽",
  "</gamebuddy-authored-source>",
  "</gamebuddy-authored-context>",
];

const VOLATILE = [
  "<gamebuddy-volatile-context>",
  "<gamebuddy-volatile-source>",
  "银行家的戒指在抽屉里。",
  "</gamebuddy-volatile-source>",
  "</gamebuddy-volatile-context>",
];

const capture = (requests, source = "local-stub-provider") => ({ ok: true, source, requests });

/**
 * One captured request as the writer must record it: the turn it answered, and the body it carried.
 *
 * The turn id is not decoration. A capture file holds every request one instance posted, so a body
 * carries the only fact that can tie it back to the turn it belongs to.
 */
const request = (turnId, body) => ({ method: "POST", url: "/chat/completions", turnId, body });

const BARE = [{ messages: [{ role: "user", content: "你好" }] }];

test("an injected authored-context block is reported with its size and the kinds it carries", async () => {
  const injection = await injectionFacts(capture([request("turn-1", systemPrompt(AUTHORED))]));
  assert.equal(injection.ok, true);
  const [turn] = injection.turns;
  assert.equal(turn.turnId, "turn-1");
  assert.equal(turn.authoredContext.present, true);
  assert.equal(turn.authoredContext.block, "gamebuddy-authored-context");
  assert.equal(turn.authoredContext.sources, 2);
  assert.deepEqual(turn.authoredContext.kinds, ["lorebook_constant", "persona"]);
  assert.equal(
    turn.authoredContext.bytes,
    Buffer.byteLength(AUTHORED.join("\n"), "utf8"),
    "the size is the block's own bytes, not the system prompt's",
  );
});

test("each body is read against its own turn id, whatever order the file lists them in", async () => {
  /*
   * The file's order is arrival order, and arrival order is NOT turn order: a retried turn, a
   * provider liveness probe or a second surface interleaves freely, and a body can land before the
   * turn it belongs to is even known. Reading by index attributes turn A's prompt to turn B the
   * moment one record is inserted ahead of it.
   */
  const outOfOrder = capture([request("turn-b", systemPrompt(BARE)), request("turn-a", systemPrompt(AUTHORED))]);
  const injection = await injectionFacts(outOfOrder, ["turn-a", "turn-b"]);
  assert.equal(injection.ok, true);
  const byTurn = new Map(injection.turns.map((turn) => [turn.turnId, turn]));
  assert.deepEqual(
    [...byTurn.keys()].sort(),
    ["turn-a", "turn-b"],
    "both turns must be reported, each under its own id",
  );
  assert.equal(
    byTurn.get("turn-a").authoredContext.present,
    true,
    "turn-a's body carries the authored block, so turn-a is the turn it belongs to - a reader indexing the file reports turn-b's bare prompt as turn-a",
  );
  assert.equal(byTurn.get("turn-b").authoredContext.present, false);
});

test("a body with no matching turn is unobserved, never guessed", async () => {
  /* Two records, and this driver observed one of its turns plus one it has no capture for. */
  const injection = await injectionFacts(
    capture([request("turn-a", systemPrompt(AUTHORED)), request("turn-b", systemPrompt(BARE))]),
    ["turn-a", "turn-c"],
  );
  assert.deepEqual(
    injection.turns.map((turn) => turn.turnId),
    ["turn-a"],
    "turn-c has no captured body, and turn-b belongs to another turn: neither may be reported as turn-c",
  );
  assert.deepEqual(injection.missing, ["turn-c"], "the turn this driver ran and cannot read is named");
  assert.equal(injection.foreign, 1, "one record belongs to a turn this driver did not observe");
});

test("the volatile block's entries are named, and a block naming itself is preferred over its first line", async () => {
  const named = [
    "<gamebuddy-volatile-context>",
    '<gamebuddy-volatile-source name="银行家的戒指">',
    "戒指在抽屉里。",
    "</gamebuddy-volatile-source>",
    "</gamebuddy-volatile-context>",
  ];
  const read = await injectionFacts(capture([request("turn-1", systemPrompt(named))]));
  assert.deepEqual(read.turns[0].volatileContext.names, ["银行家的戒指"]);
  assert.equal(read.turns[0].volatileContext.namesFrom, "attribute");

  const unnamed = await injectionFacts(capture([request("turn-1", systemPrompt(VOLATILE))]));
  assert.deepEqual(unnamed.turns[0].volatileContext.names, ["银行家的戒指在抽屉里。"]);
  assert.equal(
    unnamed.turns[0].volatileContext.namesFrom,
    "block-first-line",
    "the block carries no name, so the reading must say the excerpt is prose rather than a title",
  );
});

test("an absent block is absence, not a zero-byte block", async () => {
  const injection = await injectionFacts(capture([request("turn-1", systemPrompt(BARE))]));
  assert.deepEqual(injection.turns[0].authoredContext, { present: false });
  assert.deepEqual(injection.turns[0].volatileContext, { present: false });
  assert.equal("bytes" in injection.turns[0].authoredContext, false, "a block that is not there has no size");
});

test("a turn with no body still counts as a turn, and says what it carried", async () => {
  const injection = await injectionFacts(capture([request("turn-1", null), request("turn-2", systemPrompt(AUTHORED))]));
  assert.equal(injection.turns.length, 1, "a null body is not a turn; the surviving one is reported");
  assert.equal(injection.turns[0].turnId, "turn-2", "and it is reported as the turn it belongs to, not as turn 1");
  assert.equal(injection.turns[0].authoredContext.present, true);
});

test("a record with no turn id cannot be attributed, and says so rather than claiming a position", async () => {
  const injection = await injectionFacts(
    capture([{ method: "POST", url: "/chat/completions", body: systemPrompt(AUTHORED) }]),
  );
  assert.equal(injection.ok, false, "a body nobody labelled is a body that could belong to any turn");
  assert.match(injection.reason, /capture_records_carry_no_turnId/u);

  const mixed = await injectionFacts(
    capture([
      { method: "POST", url: "/chat/completions", body: systemPrompt(AUTHORED) },
      request("turn-2", systemPrompt(BARE)),
    ]),
  );
  assert.equal(mixed.unlabelled, 1, "the labelled record is readable; the unlabelled one is counted, not guessed");
  assert.deepEqual(
    mixed.turns.map((turn) => turn.turnId),
    ["turn-2"],
  );
});

test("the reading names the instance whose wire it describes, or refuses to describe one", async () => {
  const stub = await injectionFacts(capture([request("turn-1", systemPrompt(AUTHORED))]));
  assert.equal(stub.source, "local-stub-provider");

  const remote = await injectionFacts(capture([request("turn-1", systemPrompt(AUTHORED))], "remote-gateway"));
  assert.equal(remote.ok, false, "a gateway's traffic leaves the machine; the browser side cannot read it");
  assert.equal(remote.reason, "no_provider_request_capture:remote_gateway_wire_unintercepted");

  const undeclared = await injectionFacts({
    ok: true,
    requests: [request("turn-1", systemPrompt(AUTHORED))],
  });
  assert.equal(
    undeclared.ok,
    false,
    "a capture that does not say which instance wrote it describes no instance, so its blocks are not a reading",
  );
  assert.match(undeclared.reason, /capture_source_undeclared/u);
});

test("no capture is not an empty injection", async () => {
  for (const missing of [
    undefined,
    null,
    { ok: false, reason: "no_provider_request_capture:capture_file_absent:x.json" },
  ]) {
    const injection = await injectionFacts(missing);
    assert.equal(injection.ok, false, "an unobserved request must never read as a request with nothing in it");
    assert.match(injection.reason, /no_provider_request_capture/u);
  }
});

test("an empty request list is still unobserved rather than a turn with nothing injected", async () => {
  const injection = await injectionFacts(capture([]));
  assert.equal(injection.ok, false);
  assert.match(injection.reason, /no_parsed_request_body/u);
});

test("the INJECTION line carries the turn id and the instance, and says which turn it could not read", async () => {
  /*
   * A driver shares the page with the other nineteen, so it must report only the turn it observed -
   * by id - and must say `unobserved` for a turn it ran while the capture holds nothing for it.
   */
  const lines = [];
  const page = fakePage([
    { entryType: "mark", name: "gamebuddy:turn:submit", startTime: 10, detail: { turnKey: "turn-a" } },
    { entryType: "mark", name: "gamebuddy:turn:settled", startTime: 60, detail: { turnKey: "turn-a" } },
    { entryType: "mark", name: "gamebuddy:turn:submit", startTime: 70, detail: { turnKey: "turn-c" } },
  ]);
  await observe(page, (line) => lines.push(line), "f", {
    sinceMs: 0,
    capturedRequests: capture([request("turn-a", systemPrompt(AUTHORED)), request("turn-z", systemPrompt(BARE))]),
  });
  const injection = lines.filter((line) => line.startsWith("INJECTION f turn="));
  assert.deepEqual(
    injection.map((line) => line.slice(0, line.indexOf(":"))),
    ["INJECTION f turn=turn-a source=local-stub-provider", "INJECTION f turn=turn-c"],
    "one line per turn this driver observed, each naming its own id and the instance the wire describes",
  );
  assert.match(injection[0], /authoredContext=present block=gamebuddy-authored-context/u);
  assert.match(injection[1], /unobserved:no_capture_for_turn/u);
  assert.match(
    lines.join("\n"),
    /INJECTION f: unobserved:1_capture_record_for_a_turn_not_observed_here/u,
    "a record belonging to another turn is reported as somebody else's, never shown as this driver's",
  );
});

test("the capture reader names an unset path, an absent file and a file holding no request array", () => {
  assert.match(readCapturedRequests(undefined).reason, /GB_SHOTS_WIRE_REQUESTS_is_unset/u);
  assert.match(
    readCapturedRequests("C:/nowhere/wire-requests.json").reason,
    /capture_file_absent/u,
    "a run that records nothing must say the file is absent, not that the request was clean",
  );
  assert.match(readCapturedRequests("capture.json", () => JSON.stringify({ nothing: 1 })).reason, /no_request_array/u);
  assert.equal(readCapturedRequests("capture.json", () => JSON.stringify([{ body: {} }])).ok, true);
  assert.equal(
    readCapturedRequests("capture.jsonl", () => '{"body":{}}\n{"body":{}}').requests.length,
    2,
    "one request per line is the shape a stub provider appends",
  );
});

/* ---------- the marks the kit reads are the marks the product emits ---------- */

test("both mark families this module reads are declared by the product, spelled the same way", () => {
  const source = readFileSync(join(REPO, "dialogue-web", "src", "composed-surface-route.ts"), "utf8");
  const turnSource = readFileSync(join(REPO, "dialogue-web", "src", "components", "turn-timings.ts"), "utf8");
  const kit = readFileSync(join(HERE, "observation.cjs"), "utf8");
  assert.match(
    source,
    /const SWITCH_MARK_PREFIX = "gamebuddy:switch:"/u,
    "the switch prefix lives in the module the switch goes through; a rename here is a kit that reads nothing",
  );
  assert.match(
    source,
    /markSwitch\(panel, "start"\)/u,
    "the switch's start mark is emitted where the selection happens",
  );
  assert.match(
    source,
    /markSwitch\(shownSurface, "done"\)/u,
    "the switch's done mark is emitted where the surface commits",
  );
  assert.match(turnSource, /TURN_MARK_PREFIX = "gamebuddy:turn:"/u);
  for (const prefix of ["gamebuddy:turn:", "gamebuddy:switch:"]) {
    assert.ok(kit.includes(`"${prefix}"`), `observation.cjs must read ${prefix} with the product's own spelling`);
  }
});
