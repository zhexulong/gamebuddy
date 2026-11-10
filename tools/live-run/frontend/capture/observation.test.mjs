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
 *                       Refusing the recording proxy's source reddens "the reading names the instance
 *                       whose wire it describes" - the run whose capture this kit now produces.
 *   the driver-level lines
 *                       Writing the foreign-record count under `INJECTION <label>: unobserved:` reddens
 *                       "the INJECTION line carries the turn key and the instance": on the run that
 *                       produced this fix the join had worked for f, n and p and the only driver-level
 *                       line left was `unobserved:1_capture_record_for_a_turn_not_observed_here`,
 *                       which reads as the driver having measured nothing. Reporting a wanted key
 *                       without the keys the capture held reddens "names both sides of the join".
 *                       A line for a driver that marked no turn reddens "a driver that ran no turn
 *                       writes no INJECTION line", and dropping a keyless mark from the timings
 *                       reddens "a stage marked for a turn with no key is named".
 *   prefixes            renaming the product's switch prefix reddens "the kit reads the marks the
 *                       product emits".
 *   the section census  removing the memory measurement from `censusOf` reddens "the census names the
 *                       identity block, the memory directory and the world book" with `session-history
 *                       reached this request, so the census must list it among the sections it carried`,
 *                       and reddens "a request missing the memory section names memory as absent" with
 *                       `the memory directory was carried (empty): the census must list it as carried,
 *                       not as absent`. That break is the defect this section was built for: under it a
 *                       request carrying a 61-byte directory and one carrying nothing read identically.
 *
 * The paint cases are the original red-proof and are unchanged: see the file's own history for why LCP
 * is a field this reader must not claim.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RECORDING_PROXY_CAPTURE_SOURCE } from "../../core/recording-provider-proxy.mjs";
import { readInjectionDeclaration } from "./injection-declaration.mjs";
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
 * One captured record as the writer appends it: the identities the Host put on the request, and the body
 * it carried.
 *
 * Two identities, and they are deliberately distinct here. `pageKey` is the submission key a browser mints
 * and marks its own turn with (`newIdempotencyKey()`), so it is the only value a driver can look a record
 * up by; `turnId` is the Host's durable `turn_<uuid>`, which no page is ever given. A reader that joined on
 * `turnId` would therefore find nothing on every real run - which is exactly what this fixture makes
 * impossible to hide.
 */
const request = (pageKey, body) => ({
  source: RECORDING_PROXY_CAPTURE_SOURCE,
  at: "2026-11-04T00:00:00.000Z",
  method: "POST",
  path: "/v1/chat/completions",
  turnId: `turn_${pageKey}`,
  idempotencyKey: pageKey,
  body,
});

/** A capture file as the proxy writes it: one record per line, each naming its own source. */
const asLines = (records) => records.map((record) => JSON.stringify(record)).join("\n");

const BARE = [{ messages: [{ role: "user", content: "你好" }] }];

/**
 * The shape this product actually posts: the authored catalogue is the FIRST USER message (the cached
 * prefix's M0) and the volatile sources are the message after it - the system message carries only the
 * Host's floor and the card's voice.
 */
const productRequest = (authored, volatile) => ({
  messages: [
    { role: "system", content: "You are 琥珀, accompanying the player." },
    { role: "user", content: [{ type: "text", text: authored.join("\n") }] },
    { role: "user", content: [{ type: "text", text: volatile.join("\n") }] },
    { role: "assistant", content: "起来啦？" },
    { role: "user", content: "你好" },
  ],
});

test("the blocks are read from the messages that carry them, not only from the system prompt", async () => {
  /*
   * Measured on a real run: the request carried `<gamebuddy-authored-context version="v2">` with two
   * sources as its first user message, and a reader that asked the system message alone answered
   * `authoredContext=absent` - an absence belonging to the reader, which is the one thing this section
   * must never report.
   */
  const injection = await injectionFacts(capture([request("key-1", productRequest(AUTHORED, VOLATILE))]), ["key-1"]);
  assert.equal(injection.ok, true);
  const [turn] = injection.turns;
  assert.equal(turn.authoredContext.present, true, "the block is in a user message, and that is a reading of it");
  assert.equal(turn.authoredContext.block, "gamebuddy-authored-context");
  assert.equal(turn.authoredContext.sources, 2);
  assert.deepEqual(turn.authoredContext.kinds, ["lorebook_constant", "persona"]);
  assert.equal(turn.volatileContext.present, true);
  assert.deepEqual(turn.volatileContext.names, ["银行家的戒指在抽屉里。"]);
  assert.equal(turn.volatileContext.namesFrom, "block-first-line");
});

test("a turn that carried no volatile sources says so while its authored block still reads", async () => {
  const later = productRequest(AUTHORED, ["<session-history-since>(no new content since last materialization)"]);
  const injection = await injectionFacts(capture([request("key-1", later)]), ["key-1"]);
  assert.deepEqual(
    injection.turns[0].volatileContext,
    { present: false },
    "a turn whose volatile block was empty is a turn that carried none, not a zero-byte block",
  );
  assert.equal(injection.turns[0].authoredContext.present, true);
});

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

test("each body is read against the submission key its own turn was observed under", async () => {
  /*
   * The file's order is arrival order, and arrival order is NOT turn order: a retried turn, a
   * provider liveness probe or a second surface interleaves freely, and a body can land before the
   * turn it belongs to is even known. Reading by index attributes turn A's prompt to turn B the
   * moment one record is inserted ahead of it.
   */
  const outOfOrder = capture([request("key-b", systemPrompt(BARE)), request("key-a", systemPrompt(AUTHORED))]);
  const injection = await injectionFacts(outOfOrder, ["key-a", "key-b"]);
  assert.equal(injection.ok, true);
  const byTurn = new Map(injection.turns.map((turn) => [turn.turnId, turn]));
  assert.deepEqual(
    [...byTurn.keys()].sort(),
    ["key-a", "key-b"],
    "both turns must be reported, each under the key the page knows it by",
  );
  assert.equal(
    byTurn.get("key-a").authoredContext.present,
    true,
    "key-a's body carries the authored block, so key-a is the turn it belongs to - a reader indexing the file reports key-b's bare prompt as key-a",
  );
  assert.equal(byTurn.get("key-b").authoredContext.present, false);
});

test("a body with no matching submission key is unobserved, never guessed", async () => {
  /* Two records, and this driver observed one of its turns plus one it has no capture for. */
  const injection = await injectionFacts(
    capture([request("key-a", systemPrompt(AUTHORED)), request("key-b", systemPrompt(BARE))]),
    ["key-a", "key-c"],
  );
  assert.deepEqual(
    injection.turns.map((turn) => turn.turnId),
    ["key-a"],
    "key-c has no captured body, and key-b belongs to another turn: neither may be reported as key-c",
  );
  assert.deepEqual(injection.missing, ["key-c"], "the turn this driver ran and cannot read is named");
  assert.deepEqual(
    injection.heldKeys,
    ["key-a", "key-b"],
    "the capture's own keys are returned so a caller can name the join it could not make, rather than printing a count",
  );
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

/* ---------- the section census ---------- */

/*
 * The head a real game turn posts, section by section: the authored block with the scope it declares, one
 * authored kind, the memory directory, and - in the message after it - the world book with the card's
 * closing direction at the tail. Every expected size below is derived from the text that carries it, so no
 * byte count in these tests is a second hand-written copy of the fixture.
 */
const SCOPE = 'continuity-id="cont-1" session-id="sess-1" thread-id="thread-1"';
const AUTHORED_TAG = `<gamebuddy-authored-context version="v2" ${SCOPE}>`;
const PERSONA_ELEMENT = [
  '<gamebuddy-authored-source kind="persona">',
  "她叫艾米丽",
  "</gamebuddy-authored-source>",
].join("\n");
const AUTHORED_BLOCK = `${AUTHORED_TAG}\n${PERSONA_ELEMENT}\n</gamebuddy-authored-context>`;
const MEMORY_INNER = "## 1-2 · 2026-11-04 · 开荒\n两人把荒地翻了一遍。";
const WORLD_BOOK = [
  "<gamebuddy-volatile-context>",
  "<gamebuddy-volatile-source>",
  "银行家的戒指在抽屉里。",
  "</gamebuddy-volatile-source>",
  "</gamebuddy-volatile-context>",
].join("\n");
const CLOSING = ["<character-closing-direction>", "一句家常话收住；说清就停。", "</character-closing-direction>"].join(
  "\n",
);

/** One captured body shaped like this product's: head in m0, world book in m1, closing direction at the tail. */
const censusRequest = (head, volatile = WORLD_BOOK) => ({
  messages: [
    { role: "system", content: "You are 琥珀, accompanying the player." },
    { role: "user", content: [{ type: "text", text: head }] },
    { role: "user", content: [{ type: "text", text: volatile }] },
    { role: "assistant", content: "起来啦？" },
    { role: "user", content: CLOSING },
  ],
});

const HEAD = `${AUTHORED_BLOCK}\n<session-history>${MEMORY_INNER}</session-history>`;

/** The trailing census segment of an INJECTION line, built from the fixture's own text. */
const censusReading = (sections, absent) =>
  `sections=${sections.map(([name, bytes]) => `${name}:${bytes}B`).join(",")} absent=${absent.join(",")}`;

test("the census names the identity block, the memory directory and the world book, each with its bytes", async () => {
  const captured = capture([request("key-1", censusRequest(HEAD))]);
  const injection = await injectionFacts(captured, ["key-1"]);
  assert.equal(injection.ok, true, injection.reason);
  const [turn] = injection.turns;
  /* Presence first: a section the census stopped looking for must fail by NAME, not as an undefined size. */
  const bytesOf = (name) => {
    const section = turn.census.sections.find((entry) => entry.name === name);
    assert.ok(
      section !== undefined,
      `${name} reached this request, so the census must list it among the sections it carried`,
    );
    return section.bytes;
  };
  assert.equal(
    bytesOf("gamebuddy-authored-context"),
    Buffer.byteLength(AUTHORED_TAG),
    "the identity the block declares - the scope attributes on its own opening tag - is its own section",
  );
  assert.equal(bytesOf("persona"), Buffer.byteLength(PERSONA_ELEMENT), "an authored kind is sized as its own element");
  assert.equal(
    bytesOf("lorebook_entry"),
    Buffer.byteLength(WORLD_BOOK),
    "the world book is sized as the block it renders",
  );
  assert.equal(
    bytesOf("session-history"),
    Buffer.byteLength(MEMORY_INNER),
    "the memory directory reports its content, so a directory carried empty reads 0 rather than a wrapper's width",
  );
  assert.equal(bytesOf("character-closing-direction"), Buffer.byteLength(CLOSING));

  const lines = [];
  await observe(fakePage(turnMarks("key-1")), (line) => lines.push(line), "f", {
    sinceMs: 0,
    capturedRequests: captured,
  });
  const wanted = censusReading(
    [
      ["gamebuddy-authored-context", Buffer.byteLength(AUTHORED_TAG)],
      ["persona", Buffer.byteLength(PERSONA_ELEMENT)],
      ["lorebook_entry", Buffer.byteLength(WORLD_BOOK)],
      ["session-history", Buffer.byteLength(MEMORY_INNER)],
      ["character-closing-direction", Buffer.byteLength(CLOSING)],
    ],
    ["scenario", "dialogue_examples", "lorebook_constant", "project-memory"],
  );
  assert.ok(
    injectionLines(lines)[0].endsWith(wanted),
    `the INJECTION line must end with the sections this request carried and the declared ones it did not:\n  want …${wanted}\n  got  ${injectionLines(lines)[0]}`,
  );
});

test("a request missing the memory section names memory as absent, while an empty one reads as carried and empty", async () => {
  /*
   * The two readings below are the whole point of the census: a section that never reached the request and a
   * section that reached it empty used to be the same silence, which is how a dropped memory section stayed
   * invisible for as long as the reading was a byte count.
   */
  const dropped = await injectionFacts(capture([request("key-1", censusRequest(AUTHORED_BLOCK))]), ["key-1"]);
  const [missing] = dropped.turns;
  assert.equal(
    missing.census.absent.includes("session-history"),
    true,
    "the memory directory did not reach this request, and the reading says so by name",
  );
  assert.equal(
    missing.census.sections.some((section) => section.name === "persona"),
    true,
    "the reading still reports the sections that DID arrive: absence is named per section, not per request",
  );

  const emptyHead = [AUTHORED_BLOCK, "<session-history></session-history>"].join("\n");
  const empty = await injectionFacts(capture([request("key-1", censusRequest(emptyHead))]), ["key-1"]);
  const [emptyTurn] = empty.turns;
  const carriedEmpty = emptyTurn.census.sections.find((section) => section.name === "session-history");
  assert.ok(
    carriedEmpty !== undefined,
    "the memory directory was carried (empty): the census must list it as carried, not as absent",
  );
  assert.equal(carriedEmpty.bytes, 0, "a directory that was carried and held nothing costs zero content bytes");
  assert.equal(
    emptyTurn.census.absent.includes("session-history"),
    false,
    "carried-but-empty is not absent: confusing the two is the defect this section exists to end",
  );
});

test("a delta envelope is not a memory directory: <session-history-since> does not read as <session-history>", async () => {
  /*
   * The envelope and the directory share a prefix, and a boundary written as `\b` matches both (a hyphen is
   * a word boundary). This request carries the delta envelope - wrapped around the world book, as the real
   * wire does - and no directory at all; a reader that confused them would report memory present and size it
   * by somebody else's block.
   */
  const envelope = ["<session-history-since>", WORLD_BOOK, "</session-history-since>"].join("\n");
  const injection = await injectionFacts(capture([request("key-1", censusRequest(AUTHORED_BLOCK, envelope))]), [
    "key-1",
  ]);
  const [turn] = injection.turns;
  assert.deepEqual(
    turn.census.sections.map((section) => section.name),
    ["gamebuddy-authored-context", "persona", "lorebook_entry", "character-closing-direction"],
    "the envelope is transport: only the world book inside it is a section, and no memory directory appears",
  );
  assert.equal(
    turn.census.absent.includes("session-history"),
    true,
    "the memory directory did not reach this request, and the delta envelope does not stand in for it",
  );
});

test("a request carrying no marker at all is unobserved, not a census of zeros", async () => {
  const captured = capture([request("key-a", systemPrompt(["你好"]))]);
  const injection = await injectionFacts(captured, ["key-a"]);
  assert.deepEqual(
    injection.turns[0].census.sections,
    [],
    "an empty list of carried sections would claim the reader looked and found the model told nothing",
  );
  assert.equal(injection.turns[0].unobserved, "request_carries_no_injection_marker");

  const lines = [];
  await observe(fakePage(turnMarks("key-a")), (line) => lines.push(line), "f", {
    sinceMs: 0,
    capturedRequests: captured,
  });
  assert.deepEqual(
    injectionLines(lines),
    ["INJECTION f turn=key-a source=local-stub-provider: unobserved:request_carries_no_injection_marker"],
    "a request with no marker is a request this reader cannot read, and it says which kind of nothing that is",
  );
});

test("a section name the declaration does not have is a failure that names the section", async () => {
  /*
   * Both directions of drift, in one request: a kind the union does not declare, and a whole block family the
   * authored-context module does not render. Either one is a section nobody counted, which is what the census
   * must refuse to pass in silence.
   */
  const drifted = [
    AUTHORED_TAG,
    '<gamebuddy-authored-source kind="persona_v2">',
    "她叫艾米丽",
    "</gamebuddy-authored-source>",
    "</gamebuddy-authored-context>",
    "<gamebuddy-future-context>",
    "新的块",
    "</gamebuddy-future-context>",
  ].join("\n");
  const captured = capture([request("key-a", censusRequest(drifted))]);
  const injection = await injectionFacts(captured, ["key-a"]);
  assert.deepEqual(
    injection.turns[0].census.undeclared,
    ["gamebuddy-future-context", "persona_v2"],
    "the names the wire carries and the declaration does not are returned by name, never as a count",
  );

  const lines = [];
  await observe(fakePage(turnMarks("key-a")), (line) => lines.push(line), "f", {
    sinceMs: 0,
    capturedRequests: captured,
  });
  assert.ok(
    lines.includes(
      `INJECTION f turn=key-a: section_not_in_declaration=gamebuddy-future-context,persona_v2:declaration=${JSON.stringify(injection.sections)}`,
    ),
    `a drifting section is a named failure, and the failure names the declaration it disagreed with:\n  ${lines.join("\n  ")}`,
  );
});

test("the population reader refuses a declaration it cannot read, and names the anchor", () => {
  const missing = readInjectionDeclaration(() => {
    throw new Error("ENOENT: no such file or directory");
  });
  assert.equal(missing.ok, false, "a population that cannot be read is not an empty population");
  assert.match(
    missing.reason,
    /injection_declaration_unreadable:vendor\/magic-context\/packages\/pi-plugin\/src\/gamebuddy-stable-context-source\.ts:absent/u,
    "the file this reader could not open is named",
  );

  /* A file that still exists but no longer holds the declaration is a different fact: the anchor is named. */
  const drifted = readInjectionDeclaration((file) =>
    file.endsWith("gamebuddy-stable-context-source.ts")
      ? "export type NothingHere = 1;"
      : readFileSync(join(REPO, file), "utf8"),
  );
  assert.equal(drifted.ok, false);
  assert.match(
    drifted.reason,
    /injection_declaration_unreadable:.*:authored_block_tag/u,
    "the anchor that could not be found is named, so the fix is locatable without reading this reader",
  );
});

test("a capture longer than the reading's window says so, and reads the newest records", async () => {
  const many = Array.from({ length: 201 }, (_, index) => request(`key-${index}`, systemPrompt(AUTHORED)));
  const read = readCapturedRequests("capture.jsonl", () => asLines(many));
  assert.deepEqual(
    read.truncated,
    { read: 200, total: 201 },
    "a bounded reading says how much of the file it describes",
  );
  assert.equal(
    read.requests[read.requests.length - 1].idempotencyKey,
    "key-200",
    "the window is the tail: a run's own marks are near its newest requests",
  );
  assert.equal(
    read.requests.some((record) => record.idempotencyKey === "key-0"),
    false,
  );

  const lines = [];
  await observe(fakePage(turnMarks("key-200")), (line) => lines.push(line), "f", {
    sinceMs: 0,
    capturedRequests: read,
  });
  assert.ok(
    lines.includes("INJECTION f: capture_truncated:read_last=200_of=201"),
    `truncation is stated in the reading rather than left for the reader to infer:\n  ${lines.join("\n  ")}`,
  );
});

test("every block the authored-context module renders arrives as a census section", () => {
  /*
   * The census derives its population from these modules; this is the assertion that the derivation still
   * covers them. A block family the module gains without the census learning about it would otherwise surface
   * as a size nobody attributes, or not surface at all.
   */
  const declaration = readInjectionDeclaration();
  assert.equal(declaration.ok, true, declaration.reason);
  const source = readFileSync(
    join(REPO, "vendor", "magic-context", "packages", "pi-plugin", "src", "gamebuddy-stable-context-source.ts"),
    "utf8",
  );
  const rendered = [...new Set([...source.matchAll(/<(gamebuddy-[a-z0-9-]+)/gu)].map((match) => match[1]))].sort();
  assert.deepEqual(
    [...declaration.tags].sort(),
    rendered,
    "a block family this module renders must arrive as a census section, not as an unremarked size",
  );
  assert.deepEqual(
    [...declaration.stableKinds].sort(),
    ["dialogue_examples", "lorebook_constant", "persona", "scenario"],
    "the kinds are the union's own, so a kind added there is a section here without touching this file",
  );
});

test("a turn with no body still counts as a turn, and says what it carried", async () => {
  const injection = await injectionFacts(capture([request("turn-1", null), request("turn-2", systemPrompt(AUTHORED))]));
  assert.equal(injection.turns.length, 1, "a null body is not a turn; the surviving one is reported");
  assert.equal(injection.turns[0].turnId, "turn-2", "and it is reported as the turn it belongs to, not as turn 1");
  assert.equal(injection.turns[0].authoredContext.present, true);
});

test("a record that names no submission key cannot be attributed to a page, and says so", async () => {
  const injection = await injectionFacts(
    capture([{ method: "POST", path: "/v1/chat/completions", turnId: "turn_orphan", body: systemPrompt(AUTHORED) }]),
  );
  assert.equal(injection.ok, false, "a body this reader cannot tie to any page's turn is not a reading of one");
  assert.match(injection.reason, /capture_records_carry_no_submission_key/u);

  const mixed = await injectionFacts(
    capture([
      { method: "POST", path: "/v1/chat/completions", turnId: "turn_orphan", body: systemPrompt(AUTHORED) },
      request("key-b", systemPrompt(BARE)),
    ]),
  );
  assert.equal(
    mixed.unjoinable,
    1,
    "a record naming the Host's turn but no submission key is counted as unjoinable, never guessed into another turn",
  );
  assert.deepEqual(
    mixed.turns.map((turn) => turn.turnId),
    ["key-b"],
  );

  const identityless = await injectionFacts(
    capture([
      { method: "GET", path: "/v1/models", turnId: null, idempotencyKey: null, body: { object: "list" } },
      request("key-b", systemPrompt(BARE)),
    ]),
  );
  assert.equal(identityless.unlabelled, 1, "a probe that names no turn at all is counted, not attributed");
});

test("the reading names the instance whose wire it describes, or refuses to describe one", async () => {
  const stub = await injectionFacts(capture([request("key-1", systemPrompt(AUTHORED))]));
  assert.equal(stub.source, "local-stub-provider");

  /* The wire a run forwards through the recording proxy is still a wire served on this machine. */
  const forwarded = await injectionFacts(
    capture([request("key-1", systemPrompt(AUTHORED))], RECORDING_PROXY_CAPTURE_SOURCE),
    ["key-1"],
  );
  assert.equal(
    forwarded.ok,
    true,
    "a capture written by the recording proxy is this run's own wire, so its blocks are a reading",
  );
  assert.equal(forwarded.source, RECORDING_PROXY_CAPTURE_SOURCE);
  assert.equal(forwarded.turns[0].authoredContext.present, true);

  const remote = await injectionFacts(capture([request("key-1", systemPrompt(AUTHORED))], "remote-gateway"));
  assert.equal(remote.ok, false, "a gateway's traffic leaves the machine; the browser side cannot read it");
  assert.equal(remote.reason, "no_provider_request_capture:remote_gateway_wire_unintercepted");

  const undeclared = await injectionFacts({
    ok: true,
    requests: [request("key-1", systemPrompt(AUTHORED))],
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

/** The two marks a keyed turn leaves, in the order the product emits them. */
const turnMarks = (key, at = 10) => [
  { entryType: "mark", name: "gamebuddy:turn:submit", startTime: at, detail: { turnKey: key } },
  { entryType: "mark", name: "gamebuddy:turn:settled", startTime: at + 50, detail: { turnKey: key } },
];

/** A stage the page marked for a turn it has no key for - what a regenerated variant leaves behind. */
const keylessMark = (stage, at) => ({ entryType: "mark", name: `gamebuddy:turn:${stage}`, startTime: at });

const injectionLines = (lines) => lines.filter((line) => line.startsWith("INJECTION "));

test("the INJECTION line carries the turn key and the instance, and says which turn it could not read", async () => {
  /*
   * A driver shares the page with the other nineteen, so it must report only the turn it observed -
   * by the key the page knows it by - and must say `unobserved` for a turn it ran while the capture
   * holds nothing for it.
   */
  const lines = [];
  const page = fakePage([
    ...turnMarks("key-a", 10),
    { entryType: "mark", name: "gamebuddy:turn:submit", startTime: 70, detail: { turnKey: "key-c" } },
  ]);
  await observe(page, (line) => lines.push(line), "f", {
    sinceMs: 0,
    capturedRequests: capture([request("key-a", systemPrompt(AUTHORED)), request("key-z", systemPrompt(BARE))]),
  });
  const injection = lines.filter((line) => line.startsWith("INJECTION f turn="));
  assert.equal(injection.length, 2, "one line per turn this driver observed");
  assert.match(
    injection[0],
    /^INJECTION f turn=key-a source=local-stub-provider: authoredContext=present block=gamebuddy-authored-context/u,
    "the joined turn names its own key and the instance the wire describes",
  );
  assert.equal(
    injection[1],
    'INJECTION f turn=key-c: unobserved:no_capture_for_turn:capture_holds=["key-a","key-z"]',
    "the turn this driver ran and cannot read is named, together with the keys the capture did hold",
  );
  assert.deepEqual(
    lines.filter((line) => line.startsWith("INJECTION f: unobserved:")),
    [],
    "key-a's body IS in the capture, so this driver has no absence to report: the count that used to be written here (`1_capture_record_for_a_turn_not_observed_here`) read as this driver's blindness on a turn it had just measured",
  );
  assert.match(
    lines.join("\n"),
    /INJECTION f: capture_keys_with_no_turn_mark_here=\["key-z"\]/u,
    "a record for a turn this driver never marked is named by its key, and named as a fact about the shared file rather than as this driver's absence",
  );
});

test("a capture holding only other turns' keys says so, and names both sides of the join", async () => {
  const lines = [];
  await observe(fakePage(turnMarks("key-a", 10)), (line) => lines.push(line), "f", {
    sinceMs: 0,
    capturedRequests: capture([request("key-b", systemPrompt(AUTHORED))]),
  });
  assert.deepEqual(
    injectionLines(lines),
    [
      'INJECTION f turn=key-a: unobserved:no_capture_for_turn:capture_holds=["key-b"]',
      'INJECTION f: capture_keys_with_no_turn_mark_here=["key-b"]',
    ],
    "the key this driver wanted and the keys the capture held are both named: a count alone leaves the next reader guessing which turn was read",
  );
});

test("a turn marked with no submission key is reported as exactly that", async () => {
  /* The page marked a stage of a turn and cannot name it, so there is nothing to look up. */
  const lines = [];
  await observe(fakePage([keylessMark("accepted", 5)]), (line) => lines.push(line), "f", {
    sinceMs: 0,
    capturedRequests: capture([request("key-a", systemPrompt(AUTHORED))]),
  });
  assert.deepEqual(
    injectionLines(lines),
    ["INJECTION f: unobserved:observed_turn_has_no_turnId"],
    "an unkeyed mark is an observation this reader cannot join, and it says so instead of borrowing another turn's key",
  );
});

test("a driver that ran no turn writes no INJECTION line at all", async () => {
  /*
   * Seventeen drivers observe a layout and never ask the request anything. `report.mjs` names each of
   * them as having written no line; a line here used to claim an `observed_turn_has_no_turnId` for a
   * turn nobody ran, which is a false statement about the page rather than an absence in the capture.
   */
  const lines = [];
  await observe(
    fakePage([{ entryType: "mark", name: "gamebuddy:switch:chat:done", startTime: 4 }]),
    (line) => lines.push(line),
    "h",
    {
      sinceMs: 0,
      capturedRequests: capture([request("key-a", systemPrompt(AUTHORED))]),
    },
  );
  assert.deepEqual(injectionLines(lines), [], "the driver asked the request nothing, so it has no reading to give");
});

test("a stage marked for a turn with no key is named rather than silently dropped from the timings", async () => {
  /*
   * Regenerating a reply starts a real turn and posts a real request, and the page marks its stages
   * without a submission key. Those marks used to vanish from `TIMINGS` (no `submit` mark, so no row)
   * and their request showed up only as a count of records "for a turn not observed here" - the
   * unreadable half of the same defect.
   */
  const lines = [];
  await observe(
    fakePage([...turnMarks("key-a", 10), keylessMark("accepted", 80), keylessMark("first-token", 90)]),
    (line) => lines.push(line),
    "f",
    { sinceMs: 0, capturedRequests: capture([request("key-a", systemPrompt(AUTHORED))]) },
  );
  assert.match(
    lines.join("\n"),
    /TIMINGS f: marks_with_no_submission_key=2 stages=\["accepted","first-token"\]/u,
    "a mark the page emitted and this reader cannot attribute is a named fact, not a shortened row list",
  );
  assert.match(lines.join("\n"), /TIMINGS f turn=key-a: settled=50ms/u, "the keyed turn keeps its own row");
});

/** A minimal line that declares its writer, so the reader's agreement rule is testable without a proxy. */
const lineWithSource = (source) =>
  JSON.stringify({ source, at: "2026-11-04T00:00:00.000Z", method: "POST", path: "/v1/chat/completions", body: {} });

test("the capture reader accepts only lines that agree about which instance wrote them", () => {
  assert.match(readCapturedRequests(undefined).reason, /GB_SHOTS_WIRE_REQUESTS_is_unset/u);
  assert.match(
    readCapturedRequests("C:/nowhere/wire-requests.jsonl").reason,
    /capture_file_absent/u,
    "a run that records nothing must say the file is absent, not that the request was clean",
  );
  assert.match(
    readCapturedRequests("capture.jsonl", () => "\n  \n").reason,
    /capture_file_empty/u,
    "zero records is not a capture that saw zero requests",
  );
  assert.match(
    readCapturedRequests("capture.jsonl", () => `${lineWithSource(RECORDING_PROXY_CAPTURE_SOURCE)}\nnot json`).reason,
    /capture_file_unreadable:line_2/u,
    "the line that could not be read is the one named",
  );
  assert.match(
    readCapturedRequests(
      "capture.jsonl",
      () => `${lineWithSource(RECORDING_PROXY_CAPTURE_SOURCE)}\n${JSON.stringify({ body: {} })}`,
    ).reason,
    /capture_source_undeclared:line_2/u,
    "a line that names no writer is refused by name: a source is never inherited from the line before it",
  );
  assert.match(
    readCapturedRequests("capture.jsonl", () => `${lineWithSource("a")}\n${lineWithSource("b")}`).reason,
    /capture_source_conflict:a_vs_b:line_2/u,
    "two writers in one file is not a reading of one wire, and both are named",
  );
  const agreed = readCapturedRequests(
    "capture.jsonl",
    () => `${lineWithSource(RECORDING_PROXY_CAPTURE_SOURCE)}\n${lineWithSource(RECORDING_PROXY_CAPTURE_SOURCE)}`,
  );
  assert.equal(agreed.ok, true);
  assert.equal(agreed.source, RECORDING_PROXY_CAPTURE_SOURCE);
  assert.equal(
    agreed.requests.length,
    2,
    "every line declaring the same writer is what a capture of one wire looks like",
  );
});

test("a whole-document capture is not a line-per-record file, and is refused by that name", async () => {
  /* The writer appends one record per line; a document left over from another shape must fail visibly. */
  const read = readCapturedRequests("capture.jsonl", () =>
    JSON.stringify({ source: RECORDING_PROXY_CAPTURE_SOURCE, requests: [] }),
  );
  assert.equal(read.ok, false);
  assert.match(read.reason, /capture_line_is_not_a_record:line_1/u);
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
