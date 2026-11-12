/*
 * red-proof: this file's assertions were each seen red once, on a real injected violation, with both
 * readings quoted:
 *
 *   the memory fact removed from the carried turn's body while its `<project-memory>` section stayed
 *   -> "all three claims are proven ..." red, `carried_direction_failed section_without_the_fact`;
 *   the world-book entry's prose added to the ABSENT turn's body
 *   -> "the world-book absent direction ..." red, `absent_direction_failed inAuthoredBlock=true`;
 *   `temperature` dropped from the carried turn's body
 *   -> `carried_direction_failed temperature=not-carried`.
 *
 * The preset claim's assertions, each seen red once on a real injected violation (the injections and their red
 * readings, re-runnable through `scratch/red-proof-injection-claims.mjs`):
 *
 *   the absent side allowed to ignore a sampler that outlived the unbind
 *   -> "a sampler that outlives its unbind ..." red, `absent_direction_failed` no longer caught;
 *   any index accepted as the block a marker's placement rule names
 *   -> "a preset entry that lands outside the block ..." red, `markers_out_of_place` unreported;
 *   a sampler key present with ANY value counted as the preset's
 *   -> "a sampler value that is present but is another layer's ..." red;
 *   the markers alone allowed to make the preset carried
 *   -> "a prefixed preset whose sampler never reached the body ..." red, `sampling_not_carried` lost;
 *   the seam census pointed at a name nothing calls any more
 *   -> both seam tests red, the expiry among them;
 *   one more marker expected than the probe planted
 *   -> "all three claims are proven ..." red (the deepEqual of the three verdicts).
 *
 * The memory reading's own red proof, run when it was changed to name the block that carries the fact: the
 * reader was made to count a present section as carrying the fact (`factInSection: factSection !== null ||
 * blocks.length > 0`), and "a present-but-empty memory directory is not a reading that carried the fact" went
 * red reporting `carried` (verdict `proven`) for a fact in NEITHER block - the false pass this file exists to
 * catch. Restored, it reads `section_without_the_fact` / `carried_direction_failed`.
 *
 * WHAT THE MACHINE CANNOT SAY, stated here so a green file is not read as a live measurement: every
 * body below is a FIXTURE shaped like the product's wire (an m[0] user message carrying the authored
 * catalogue and the memory directory, an m[1] carrying the volatile entries and the memory delta, sampling
 * values as top-level fields). What that proves is that the INSTRUMENT distinguishes the two directions -
 * that a capture which lost a fact reads as failed instead of as absent, and one that carries it reads as
 * carried. It does not prove the product puts anything there; only a live run's capture can, and the
 * run's own `INJECTION claim=` lines are that reading.
 *
 * The memory claim is labelled "injection path, not fold" in the test names that exercise it, because a
 * compartment is MODEL OUTPUT: a body that carries `<project-memory>` was written by the product from a
 * durable row, and no row here was ever folded. Nothing in this file stands in for the fold.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { describeClaims, presetSamplingCallers, readClaimsFromCaptureFile } from "./injection-claims.mjs";

/** The text a fact uses. Opaque and unique, so one `indexOf` decides presence. */
const MEMORY_FACT = "gbw3-memory-fact: the spare key is under the third pot";
/** The row a PLAYER writes through the Memory panel while the Chat is mounted: a different row, a different block. */
const PLAYER_MEMORY_FACT = "gbw3-player-memory-fact: the watering can lives behind the mill";
const WORLDBOOK_ENTRY = "gbw3-worldbook-entry: the lighthouse keeper is called Maren";
const SAID = "gbw3-player-line";
/** The three preset markers, one per placement bucket, and the sampler value the probe reads. */
const PRESET_MARKERS = Object.freeze({
  before: "gbp4-test-prefix-marker",
  after: "gbp4-test-tail-marker",
  depth: "gbp4-test-depth-marker",
});
const PRESET_TEMPERATURE = 0.9;

/**
 * The authored block, one `<gamebuddy-authored-source kind=...>` per section. The world-book entries this
 * kit plants are the book's ALWAYS-ON ones, so they ride this block (the m[0] prefix) and not the m[1]
 * volatile block a keyword-gated entry needs a trigger word for.
 */
const AUTHORED = (...sources) =>
  `<gamebuddy-authored-context version="v2">\n${sources
    .map(([kind, text]) => `<gamebuddy-authored-source kind="${kind}">${text}</gamebuddy-authored-source>`)
    .join("\n")}\n</gamebuddy-authored-context>`;

/**
 * One provider request body, shaped as the product posts it.
 *
 * The authored catalogue rides a USER message (the cached prefix's m[0]) and the volatile entries the
 * message after it - a reading that only asked the system message would report the authored context
 * absent on a turn that carried it, which is the defect `observation.cjs` already paid for once.
 *
 * `preset` shapes the three placements the bound preset produces: the prefix joins the LEADING SYSTEM
 * message's text, and the tail and depth entries are `user` messages after the player's own line.
 */
function bodyOf({ memory = null, entry = null, temperature = null, history = "", delta = null, preset = null }) {
  const head = [
    history.length === 0 ? "<session-history></session-history>" : `<session-history>\n${history}\n</session-history>`,
    memory === null ? "" : `<project-memory>\n${memory}\n</project-memory>`,
    AUTHORED(["scenario", "the valley premise"], ...(entry === null ? [] : [["lorebook_constant", entry]])),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  /* The m[1] delta the product writes for a memory created after the baseline (`<new-memories>`), on the
   * message the product puts it on. */
  const newMemories = delta === null ? "" : `<new-memories>\n${delta}\n</new-memories>`;
  return {
    model: "fixture-model",
    messages: [
      { role: "system", content: preset === null ? "the Host floor" : `the Host floor\n\n${preset.before}` },
      { role: "user", content: head },
      { role: "user", content: [newMemories, SAID].filter((part) => part.length > 0).join("\n") },
      ...(preset === null
        ? []
        : [
            { role: "user", content: preset.after },
            { role: "user", content: preset.depth },
          ]),
    ],
    ...(temperature === null ? {} : { temperature }),
  };
}

/** A capture file written by the same shape the recording proxy appends. */
function captureFile(records) {
  const directory = mkdtempSync(join(tmpdir(), "injection-claims-"));
  const file = join(directory, "wire-requests.jsonl");
  writeFileSync(
    file,
    `${records
      .map((record) =>
        JSON.stringify({
          source: "recording-provider-proxy",
          at: "2026-11-10T00:00:00.000Z",
          method: "POST",
          path: "/v1/chat/completions",
          turnId: `turn_${record.key}`,
          idempotencyKey: record.key,
          body: record.body,
        }),
      )
      .join("\n")}\n`,
    "utf8",
  );
  return file;
}

const probeFor = (carried, absent) => ({
  said: SAID,
  memory: { fact: MEMORY_FACT, turns: { carried, absent } },
  playerMemory: { fact: PLAYER_MEMORY_FACT, turns: { carried, absent } },
  worldBook: { text: WORLDBOOK_ENTRY, turns: { carried, absent } },
  preset: {
    playerLine: SAID,
    markers: PRESET_MARKERS,
    sampling: { key: "temperature", value: PRESET_TEMPERATURE },
    turns: { carried, absent },
  },
});

const claimOf = (reading, name) => reading.claims.find((claim) => claim.name === name);

/** The bound turn, and the turn where nothing was bound. */
const boundRun = (overrides = {}) =>
  captureFile([
    {
      key: "key-bound",
      body:
        overrides.carried ??
        bodyOf({
          memory: MEMORY_FACT,
          delta: PLAYER_MEMORY_FACT,
          entry: WORLDBOOK_ENTRY,
          temperature: PRESET_TEMPERATURE,
          preset: PRESET_MARKERS,
        }),
    },
    { key: "key-unbound", body: overrides.absent ?? bodyOf({}) },
  ]);

test("all four claims are proven when the bound turn carries each fact and the unbound turn carries none", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun(),
    probe: probeFor("key-bound", "key-unbound"),
  });
  assert.equal(reading.ok, true, `capture must be readable: ${reading.reason}`);
  assert.deepEqual(
    reading.claims.map((claim) => `${claim.name}=${claim.verdict}`),
    ["memory=proven", "playerMemory=proven", "worldBook=proven", "preset=proven"],
    `every claim needs both directions:\n${JSON.stringify(reading.claims, null, 1)}`,
  );
  /*
   * The player-authored claim names its blocks out of the declaration rather than out of a hand-written string:
   * the block that carried the row is reported, and it is one of the blocks the product declares.
   */
  const playerMemory = claimOf(reading, "playerMemory");
  assert.equal(playerMemory.readings.carried.detail.block, "new-memories");
  assert.equal(playerMemory.readings.carried.detail.inBlock, true);
  assert.equal(playerMemory.readings.absent.detail.inBlock, false);
  assert.equal(
    playerMemory.readings.carried.detail.blockBytes > 0,
    true,
    "the census must size the block the row arrived in, so the reading and the census agree about the carrier",
  );
  const preset = claimOf(reading, "preset");
  assert.equal(preset.readings.carried.detail.markersInBody, 3);
  assert.equal(
    preset.readings.carried.detail.markersInPlace,
    3,
    "each marker is scored against its own placement rule: the prefix in the head system message, the two after the transcript",
  );
  assert.deepEqual(
    preset.readings.carried.detail.markers.map((one) => `${one.block}:${one.inItsBlock}`),
    ["before:true", "after:true", "depth:true"],
  );
  assert.equal(preset.readings.carried.detail.sampler.matches, true);
  assert.equal(preset.readings.absent.detail.markersInBody, 0);
  assert.deepEqual(
    reading.instrument,
    [],
    "a clean capture must leave the instrument silent: a finding here means the probe wrote its own evidence",
  );
  const memory = claimOf(reading, "memory");
  assert.equal(memory.readings.carried.detail.section, "project-memory");
  assert.ok(memory.readings.carried.detail.sectionBytes > 0, "a carried memory block has bytes");
  assert.equal(memory.readings.carried.detail.factInBody, true);
  assert.equal(memory.readings.absent.detail.factInBody, false);
  assert.equal(memory.readings.absent.detail.section, null, "no memory block at all is an absence");
  assert.ok(
    memory.readings.absent.detail.sectionBytes === 0,
    "an absent memory block is 0 bytes, which is why 0 and null must stay distinct readings",
  );
});

test("injection path, not fold: a memory section that arrives without its fact is not a carried reading", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({
      carried: bodyOf({
        memory: "something else entirely",
        entry: WORLDBOOK_ENTRY,
        temperature: PRESET_TEMPERATURE,
        preset: PRESET_MARKERS,
      }),
    }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const memory = claimOf(reading, "memory");
  assert.equal(memory.verdict, "carried_direction_failed");
  assert.equal(memory.readings.carried.state, "section_without_the_fact");
  assert.equal(memory.readings.carried.detail.sectionBytes > 0, true);
  assert.equal(memory.readings.carried.detail.factInBody, false);
});

test("injection path, not fold: a fact that arrives outside the memory section is named, not counted as carried", async () => {
  const drifted = bodyOf({ entry: WORLDBOOK_ENTRY, temperature: PRESET_TEMPERATURE, preset: PRESET_MARKERS });
  drifted.messages[0].content = `the Host floor, and also ${MEMORY_FACT}`;
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ carried: drifted }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const memory = claimOf(reading, "memory");
  assert.equal(memory.verdict, "carried_direction_failed");
  assert.equal(
    memory.readings.carried.state,
    "fact_outside_the_section",
    "the fact is in the request but not in the block that carries memory: reporting `carried` would credit the injection path for a quote",
  );
});

test("the world-book absent direction is what a flag that did not take effect looks like", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ absent: bodyOf({ entry: WORLDBOOK_ENTRY }) }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const worldBook = claimOf(reading, "worldBook");
  assert.equal(worldBook.verdict, "absent_direction_failed");
  assert.equal(worldBook.readings.absent.state, "present");
  assert.equal(worldBook.readings.absent.detail.inAuthoredBlock, true);
});

test("a sampler value that is present but is another layer's is not carried", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ absent: bodyOf({ temperature: 0.7 }) }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const preset = claimOf(reading, "preset");
  assert.equal(
    preset.verdict,
    "proven",
    "0.7 is not the preset's 0.9 and no marker travelled, so the unbound turn really does not carry it",
  );
  assert.equal(preset.readings.absent.detail.sampler.carried, true);
  assert.equal(preset.readings.absent.detail.sampler.value, 0.7);
  assert.equal(preset.readings.absent.detail.sampler.matches, false);
});

test("a prefixed preset whose sampler never reached the body fails that direction by name", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({
      carried: bodyOf({ memory: MEMORY_FACT, entry: WORLDBOOK_ENTRY, preset: PRESET_MARKERS }),
    }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const preset = claimOf(reading, "preset");
  assert.equal(preset.verdict, "carried_direction_failed");
  assert.equal(
    preset.readings.carried.state,
    "sampling_not_carried",
    "the three markers arrived in their blocks and the sampler did not: naming which half is what separates a misplaced preset from an unsent one",
  );
  assert.equal(preset.readings.carried.detail.sampler.carried, false);
});

test("a preset entry that lands outside the block its placement rule names is not carried", async () => {
  /*
   * `before` joins the LEADING SYSTEM message because `collapseSystemMessages` drops a later system message. A
   * preset entry that arrived in a user message carries the same bytes and is not the injection, so the reading
   * reports `markers_out_of_place` instead of counting it.
   */
  const displaced = bodyOf({ memory: MEMORY_FACT, entry: WORLDBOOK_ENTRY, temperature: PRESET_TEMPERATURE });
  displaced.messages[0].content = "the Host floor";
  displaced.messages.splice(1, 0, { role: "user", content: PRESET_MARKERS.before });
  displaced.messages.push(
    { role: "user", content: PRESET_MARKERS.after },
    { role: "user", content: PRESET_MARKERS.depth },
  );
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ carried: displaced }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const preset = claimOf(reading, "preset");
  assert.equal(preset.verdict, "carried_direction_failed");
  assert.equal(preset.readings.carried.state, "markers_out_of_place");
  assert.equal(preset.readings.carried.detail.markersInBody, 3, "all three bytes are on the wire");
  assert.equal(preset.readings.carried.detail.markersInPlace, 2, "and one is not where its own rule puts it");
});

test("a sampler that outlives its unbind is read as `present`, never rounded to absent", async () => {
  /*
   * The falsifier for the absent direction: if the composed model keeps the value (or another layer sends it),
   * the reading must say the preset is still reaching the model. The 2026-11-11 live run did NOT produce this
   * shape - its unbound turn carried no sampler at all - so this is the instrument's own falsifier, not the
   * expected outcome of a run.
   */
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ absent: bodyOf({ temperature: PRESET_TEMPERATURE }) }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const preset = claimOf(reading, "preset");
  assert.equal(preset.verdict, "absent_direction_failed");
  assert.equal(preset.readings.absent.state, "present");
  assert.equal(preset.readings.absent.detail.markersInBody, 0, "the prompts did stop at the unbind");
  assert.equal(preset.readings.absent.detail.sampler.matches, true, "and the sampler did not");
});

test("a preset probe that planted neither a marker nor a sampler key is unobserved, not absent", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun(),
    probe: { preset: { playerLine: SAID, markers: {}, turns: { carried: "key-bound", absent: "key-unbound" } } },
  });
  assert.equal(claimOf(reading, "preset").verdict, "unobserved");
  assert.equal(claimOf(reading, "preset").reason, "unobserved:probe_names_no_preset_marker_or_sampler");
});

test("a turn with no record in the capture is unobserved, never absent", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: captureFile([
      {
        key: "key-bound",
        body: bodyOf({
          memory: MEMORY_FACT,
          entry: WORLDBOOK_ENTRY,
          temperature: PRESET_TEMPERATURE,
          preset: PRESET_MARKERS,
        }),
      },
    ]),
    probe: probeFor("key-bound", "key-never-posted"),
  });
  for (const claim of reading.claims) {
    assert.equal(claim.verdict, "unobserved", `${claim.name}: a side with no turn is not a pass`);
    assert.equal(claim.reason, "unobserved:no_capture_for_turn:key-never-posted");
  }
});

test("a claim the probe names no turns for is unobserved, not absent", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun(),
    probe: { memory: { fact: MEMORY_FACT, turns: { carried: "key-bound", absent: "key-unbound" } } },
  });
  assert.equal(claimOf(reading, "worldBook").reason, "probe_names_no_turn_pair");
  assert.equal(claimOf(reading, "preset").verdict, "unobserved");
});

test("the printed lines name the readings and never carry the probe content", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun(),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const lines = describeClaims("v", reading);
  assert.ok(
    lines.every((line) => line.startsWith("INJECTION v")),
    "the report picks these up by its existing prefix",
  );
  const printed = lines.join("\n");
  for (const secret of [MEMORY_FACT, WORLDBOOK_ENTRY, SAID])
    assert.equal(
      printed.includes(secret),
      false,
      `a driver prints names and counts, never authored bytes: ${secret} reached the facts file`,
    );
  assert.ok(
    lines.some((line) => line.includes("claim=memory: proven") && line.includes("absent=")),
    `both readings belong on one line a reader can compare:\n${printed}`,
  );
  assert.ok(
    lines.some((line) => line.includes("claim=memory reading=carried:") && line.includes("factInBody=true")),
    `the carried reading needs its own detail line:\n${printed}`,
  );
});

test("injection path, not fold: a folded history does not stand in for the baseline memory block", async () => {
  /*
   * A run whose history has been folded carries a non-empty `<session-history>` on every turn, so the two
   * memory blocks are present at once and only one of them can be answering for the fact. The block that
   * carries it has to be NAMED: a reader that stopped at the first block with bytes would report
   * `section_without_the_fact` on exactly the turns where `<project-memory>` carried the fact.
   */
  const folded = "the first day, decayed: they planted the beans behind the shed";
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({
      carried: bodyOf({
        history: folded,
        memory: MEMORY_FACT,
        entry: WORLDBOOK_ENTRY,
        temperature: PRESET_TEMPERATURE,
        preset: PRESET_MARKERS,
      }),
      absent: bodyOf({
        history: folded,
        entry: WORLDBOOK_ENTRY,
        temperature: PRESET_TEMPERATURE,
        preset: PRESET_MARKERS,
      }),
    }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const memory = claimOf(reading, "memory");
  assert.equal(
    memory.verdict,
    "proven",
    `both memory blocks were carried, and one of them held the fact:\n${JSON.stringify(memory, null, 1)}`,
  );
  assert.equal(memory.readings.carried.detail.factSection, "project-memory");
  assert.equal(
    memory.readings.carried.detail.section,
    "project-memory",
    "the reading names the block that carried the fact, not the first block that happened to have bytes",
  );
  assert.equal(
    memory.readings.absent.detail.section,
    "session-history",
    "with no memory block at all, the folded history is still the block the reading reports",
  );
});

test("injection path, not fold: a present-but-empty memory directory is not a reading that carried the fact", async () => {
  /*
   * `<session-history></session-history>` is on the wire with zero content on every run without a fold, and
   * `<project-memory>` carries a DIFFERENT memory. Neither block holds the probe fact, so the reading must not
   * be `carried`: counting a section as present when its bytes are zero is how this check would report a pass it
   * never measured.
   */
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({
      carried: bodyOf({
        memory: "a memory that is not the probe fact",
        entry: WORLDBOOK_ENTRY,
        temperature: PRESET_TEMPERATURE,
        preset: PRESET_MARKERS,
      }),
    }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const memory = claimOf(reading, "memory");
  assert.equal(memory.verdict, "carried_direction_failed");
  assert.equal(memory.readings.carried.state, "section_without_the_fact");
  assert.equal(memory.readings.carried.detail.factInSection, false);
  assert.equal(memory.readings.carried.detail.factSection, null);
});

test("a memory claim reads only the blocks it names: the m[1] delta cannot answer for the baseline block", async () => {
  /*
   * A row written after a session's baseline exists reaches the next turn as `<new-memories>`, and the driver
   * names `<project-memory>` for this pair. The two are different carriers with different timings: letting the
   * delta answer would report the baseline path proven by a block it never wrote.
   */
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({
      carried: bodyOf({
        memory: "a memory that is not the probe fact",
        delta: MEMORY_FACT,
        entry: WORLDBOOK_ENTRY,
        temperature: PRESET_TEMPERATURE,
        preset: PRESET_MARKERS,
      }),
    }),
    probe: {
      memory: {
        fact: MEMORY_FACT,
        sections: ["project-memory"],
        turns: { carried: "key-bound", absent: "key-unbound" },
      },
    },
  });
  const memory = claimOf(reading, "memory");
  assert.equal(memory.verdict, "carried_direction_failed");
  assert.equal(memory.readings.carried.state, "fact_outside_the_section");
  assert.equal(
    memory.readings.carried.detail.factInBody,
    true,
    "the fact is in the request, in the delta block: not carried by the block this claim names, and not absent either",
  );
});

/* ---------- the fourth claim: the player's own write, read in the block a mounted Chat receives it in ---------- */

test("the player's own memory row is carried in a declared memory block, and the block that carried it is named", async () => {
  /*
   * Two carriers, one question. A row written while a Chat is mounted reaches the next turn either in the m[1]
   * delta (`<new-memories>`) or, when the write invalidated the m[0] baseline, in `<project-memory>` itself. The
   * live run of 2026-11-12 read the second. The claim names both out of `injection-declaration.mjs` and reports
   * which one held the row, so a product that changes carrier is a different READING rather than a failed claim.
   */
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun(),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const playerMemory = claimOf(reading, "playerMemory");
  assert.equal(playerMemory.verdict, "proven", JSON.stringify(playerMemory, null, 1));
  assert.equal(playerMemory.readings.carried.detail.block, "new-memories", "the delta carried it in this body");
  assert.equal(
    playerMemory.readings.carried.detail.blockBytes > 0,
    true,
    "the block the row arrived in is a declared census section, so its size is read from the census, not guessed",
  );
  assert.deepEqual(
    playerMemory.readings.carried.detail.leaks,
    [],
    "the marker sits inside the block that carries it: a finding here would mean it arrived somewhere else",
  );
});

test("a row that reached the baseline block instead of the delta is still carried, and says which block", async () => {
  /*
   * The shape the live run produced: the write invalidated the m[0] baseline, so the row rode the next turn's
   * prefix in `<project-memory>` and no delta block was on the wire at all. Reading only `<new-memories>` would
   * report this as `absent` - a passing-looking miss on a request that carried the row.
   */
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({
      carried: bodyOf({
        memory: PLAYER_MEMORY_FACT,
        entry: WORLDBOOK_ENTRY,
        temperature: PRESET_TEMPERATURE,
        preset: PRESET_MARKERS,
      }),
    }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const playerMemory = claimOf(reading, "playerMemory");
  assert.equal(playerMemory.verdict, "proven", JSON.stringify(playerMemory, null, 1));
  assert.equal(playerMemory.readings.carried.detail.block, "project-memory");
  assert.equal(playerMemory.readings.carried.detail.blockBytes > 0, true);
});

test("a player memory that arrived outside every memory block is named, not counted as carried", async () => {
  const drifted = bodyOf({
    memory: MEMORY_FACT,
    entry: WORLDBOOK_ENTRY,
    temperature: PRESET_TEMPERATURE,
    preset: PRESET_MARKERS,
  });
  drifted.messages[0].content = `the Host floor, and also ${PLAYER_MEMORY_FACT}`;
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ carried: drifted }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const playerMemory = claimOf(reading, "playerMemory");
  assert.equal(playerMemory.verdict, "carried_direction_failed");
  assert.equal(
    playerMemory.readings.carried.state,
    "fact_outside_the_blocks",
    "the bytes are on the wire and not in a block the product writes them into: that is a quote, not the injection",
  );
  assert.equal(playerMemory.readings.carried.detail.inBlock, false);
  assert.equal(playerMemory.readings.carried.detail.inBody, true);
});

test("a turn that carried only the compartment directory is an absence, not a row block without its fact", async () => {
  /*
   * `<session-history>` is a declared memory block and it is on the wire on every turn, empty until a fold runs.
   * Counting it as a row carrier would report `blocks_without_the_fact` on a request that carried no row block at
   * all - a near-miss where the truth is an absence.
   */
  const onlyDirectory = await readClaimsFromCaptureFile({
    captureFile: boundRun({
      carried: bodyOf({ entry: WORLDBOOK_ENTRY, temperature: PRESET_TEMPERATURE, preset: PRESET_MARKERS }),
    }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const playerMemory = claimOf(onlyDirectory, "playerMemory");
  assert.equal(playerMemory.readings.carried.detail.blocks, "", "no row carrier was on the wire");
  assert.equal(playerMemory.readings.carried.state, "absent");
  assert.equal(playerMemory.verdict, "carried_direction_failed");
});

test("a memory block that arrives without the player's row is not a carried reading", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({
      carried: bodyOf({
        memory: MEMORY_FACT,
        delta: "a different row the product rendered instead",
        entry: WORLDBOOK_ENTRY,
        temperature: PRESET_TEMPERATURE,
        preset: PRESET_MARKERS,
      }),
    }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const playerMemory = claimOf(reading, "playerMemory");
  assert.equal(playerMemory.verdict, "carried_direction_failed");
  assert.equal(playerMemory.readings.carried.state, "blocks_without_the_fact");
  assert.equal(playerMemory.readings.carried.detail.block, null);
});

test("the player-memory claim's absent direction is the SAME session before the write, so a leak there is a real failure", async () => {
  /*
   * The pair is taken inside one mounted Chat: the control is the turn taken BEFORE the write, and a marker
   * still on that wire means the row was already reaching the model before the player wrote it - the shape a
   * mount-bound pair cannot see.
   */
  const absent = bodyOf({
    memory: MEMORY_FACT,
    entry: WORLDBOOK_ENTRY,
    temperature: PRESET_TEMPERATURE,
    preset: PRESET_MARKERS,
    delta: PLAYER_MEMORY_FACT,
  });
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ absent }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const playerMemory = claimOf(reading, "playerMemory");
  assert.equal(playerMemory.verdict, "absent_direction_failed");
  assert.equal(playerMemory.readings.absent.state, "present");
});

test("a player-memory marker in an assistant message is a leak named with its role", async () => {
  const absent = bodyOf({
    memory: MEMORY_FACT,
    entry: WORLDBOOK_ENTRY,
    temperature: PRESET_TEMPERATURE,
    preset: PRESET_MARKERS,
  });
  absent.messages.push({ role: "assistant", content: `she repeated ${PLAYER_MEMORY_FACT} back` });
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ absent }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const playerMemory = claimOf(reading, "playerMemory");
  assert.deepEqual(
    playerMemory.readings.absent.detail.leaks.map((one) => `${one.label}:${one.role}:${one.reason}`),
    ["playerMemory.fact:assistant:in_an_assistant_message"],
  );
  assert.ok(
    describeClaims("v", reading).some(
      (line) =>
        line.includes("claim=playerMemory reading=absent leak:") && line.includes(`marker=${PLAYER_MEMORY_FACT}`),
    ),
    "the finding names the marker and the role it was found in",
  );
});

test("a player-memory claim with no turn pair is unobserved, never a pass", async () => {
  const noPair = await readClaimsFromCaptureFile({
    captureFile: boundRun(),
    probe: { ...probeFor("key-bound", "key-unbound"), playerMemory: { fact: PLAYER_MEMORY_FACT } },
  });
  assert.equal(claimOf(noPair, "playerMemory").verdict, "unobserved");
  assert.equal(claimOf(noPair, "playerMemory").reason, "probe_names_no_turn_pair");

  const noAbsent = await readClaimsFromCaptureFile({
    captureFile: boundRun(),
    probe: {
      ...probeFor("key-bound", "key-unbound"),
      playerMemory: { fact: PLAYER_MEMORY_FACT, turns: { carried: "key-bound", absent: null } },
    },
  });
  assert.equal(claimOf(noAbsent, "playerMemory").reason, "unobserved:no_turn_key_for:absent");
});

test("a direction that produced no turn is a missing key, not an unrecorded request", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun(),
    probe: {
      memory: { fact: MEMORY_FACT, sections: ["project-memory"], turns: { carried: "key-bound", absent: null } },
    },
  });
  const memory = claimOf(reading, "memory");
  assert.equal(memory.verdict, "unobserved", "a side with no turn is not a pass");
  assert.equal(
    memory.reason,
    "unobserved:no_turn_key_for:absent",
    "a turn that was never sent is a different silence from a request that was never recorded",
  );
});

test("a capture that was never recorded is reported as a reason, not as three absent claims", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: join(tmpdir(), "no-such-capture-file.jsonl"),
    probe: probeFor("key-bound", "key-unbound"),
  });
  assert.equal(reading.ok, false);
  assert.match(reading.reason, /^no_provider_request_capture:capture_file_absent/u);
  assert.deepEqual(describeClaims("v", reading), [`INJECTION v: unobserved:${reading.reason}`]);
});
/* ---------- the instrument's own negative assertions: a probe must not write its own evidence ---------- */

const PROBE_DIAGNOSTIC = "gbw3enabledkey and gbw3disabledkey are both in this line";

test("a marker the probe typed into its own turn is named with the role it was found in", async () => {
  /*
   * The shape this lane was opened for. The probe SUBMITTED a marker as the player's turn, and a request
   * body then carries that marker in a user message - so a body-wide `includes` credits the probe's own
   * sentence as the injection. Three readings have to say so: the claim's leak finding, the printed leak
   * line naming the marker AND the role, and the instrument finding that the probe turn carries evidence.
   */
  const typed = bodyOf({ memory: MEMORY_FACT });
  typed.messages[2].content = `${typed.messages[2].content}\n${WORLDBOOK_ENTRY}`;
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ carried: typed }),
    probe: { ...probeFor("key-bound", "key-unbound"), said: typed.messages[2].content },
  });
  const worldBook = claimOf(reading, "worldBook");
  assert.equal(worldBook.readings.carried.state, "fact_outside_the_section");
  assert.equal(worldBook.readings.carried.detail.leaks.length, 1);
  assert.equal(worldBook.readings.carried.detail.leaks[0].label, "worldBook.text", "the failure names the marker");
  assert.equal(worldBook.readings.carried.detail.leaks[0].marker, WORLDBOOK_ENTRY, "by its own bytes");
  assert.equal(worldBook.readings.carried.detail.leaks[0].role, "user", "and the role it was found in");
  const lines = describeClaims("v", reading);
  assert.ok(
    lines.some(
      (line) => line.includes("leak:") && line.includes(`marker=${WORLDBOOK_ENTRY}`) && line.includes("role=user"),
    ),
    `the printed line must name the marker and the role:\n${lines.join("\n")}`,
  );
  assert.ok(
    reading.instrument.some(
      (one) =>
        one.label === "worldBook.text" &&
        one.marker === WORLDBOOK_ENTRY &&
        one.role === "user" &&
        one.reason === "the_probe_turn_carries_its_own_evidence",
    ),
    "the instrument must say the probe turn carries its own evidence",
  );
});

test("a marker in an assistant message is a leak named with its role: model output is not injection", async () => {
  /*
   * An assistant message is model output - no probe wrote it - so a marker there can never be the product
   * injecting authored context. Planting it on the ABSENT side is the strongest shape: without the leak rule
   * the absent direction reads `absent` and the claim passes on a body that carries the bytes.
   */
  const absent = bodyOf({});
  absent.messages.push({ role: "assistant", content: `she wrote ${WORLDBOOK_ENTRY} back to herself` });
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ absent }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const worldBook = claimOf(reading, "worldBook");
  assert.equal(worldBook.verdict, "absent_direction_failed");
  assert.equal(worldBook.readings.absent.state, "present", "a marker still on the wire is not an absence");
  assert.deepEqual(
    worldBook.readings.absent.detail.leaks.map((one) => `${one.label}:${one.role}:${one.reason}`),
    ["worldBook.text:assistant:in_an_assistant_message"],
  );
});

test("the probe's own diagnostic sentence in a request body is named, never read as a claim", async () => {
  /*
   * `gbw3enabledkey and gbw3disabledkey are both in this line` is the exact sentence the probe used to submit
   * as the player's turn. It must not appear in any body again - so it is kept as a negative constant and
   * asserted against, which is the only form in which "the claim's own printed sentence" can be checked.
   */
  const absent = bodyOf({});
  absent.messages[2].content = `${absent.messages[2].content}\n${PROBE_DIAGNOSTIC}`;
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ absent }),
    probe: { ...probeFor("key-bound", "key-unbound"), diagnosticSentence: PROBE_DIAGNOSTIC },
  });
  assert.deepEqual(
    reading.instrument.map((one) => `${one.label}:${one.role}:${one.reason}`),
    ["probe.diagnosticSentence:user:the_probes_own_diagnostic_sentence"],
  );
  const lines = describeClaims("v", reading);
  assert.ok(
    lines.some(
      (line) =>
        line.includes("probe_wrote_its_own_evidence") &&
        line.includes(`marker=${PROBE_DIAGNOSTIC}`) &&
        line.includes("role=user"),
    ),
    `the instrument's finding must be printed with the marker and the role:\n${lines.join("\n")}`,
  );
});

/* ---------- the preset-sampling seam's caller census, and the exemption it ended ---------- */

/**
 * The census exists so the claim's carried reading is backed by a NAMED production writer, and it was written
 * as an exemption that expired by itself: while nothing called the seam, the claim was allowed to report
 * `unobserved:no_preset_bound_to_runtime`, and the day a caller appeared this had to go red. It did. The two
 * tests below hold that shape: the walk still finds a planted caller and still ignores the seam's own file, and
 * the Host's real sources must now name one.
 *
 * The synthetic trees are how the walk is proved to work both ways without touching the Host; an unreadable
 * root is "not measured" rather than "nothing calls it".
 */
test("a planted caller of the preset-sampling seam is named, and the seam's own file is not its caller", () => {
  const root = mkdtempSync(join(tmpdir(), "preset-seam-"));
  mkdirSync(join(root, "tavern"), { recursive: true });
  writeFileSync(
    join(root, "tavern", "preset-sampling.ts"),
    "export function withPresetSampling() { return 1; }\n",
    "utf8",
  );
  writeFileSync(join(root, "tavern", "preset-sampling.test.ts"), "withPresetSampling();\n", "utf8");
  const before = presetSamplingCallers(root);
  assert.equal(before.ok, true);
  assert.deepEqual(before.callers, [], "the definition and its own test are not callers of the seam");

  writeFileSync(
    join(root, "runtime-core.internal.ts"),
    "import { withPresetSampling } from './tavern/preset-sampling.js';\nwithPresetSampling(entry, modelId, values);\n",
    "utf8",
  );
  const after = presetSamplingCallers(root);
  assert.deepEqual(after.callers, ["runtime-core.internal.ts"], "a caller is named by its path, not counted");
});

test("a source root that cannot be read is not measured, never zero callers", () => {
  const unreadable = presetSamplingCallers(join(tmpdir(), "no-such-source-root-for-the-seam"));
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.reason, /^preset_sampling_seam_unmeasured:/u);
  assert.deepEqual(unreadable.callers, []);
});

test("the seam's exemption expired: the Host's own runtime is the caller that folds the bound preset in", () => {
  const seam = presetSamplingCallers(join(import.meta.dirname, "..", "..", "..", "..", "host", "src"));
  assert.equal(seam.ok, true, `the Host's own sources must be readable for this reading: ${seam.reason}`);
  assert.ok(seam.files > 100, `examined ${seam.files} production file(s) - an empty walk proves nothing`);
  assert.ok(
    seam.callers.length > 0,
    "nothing calls the preset-sampling seam any more, so a run cannot carry a preset's sampler: the claim must report the absence by name rather than a reading",
  );
  assert.ok(
    seam.callers.includes("runtime-core.internal.ts"),
    `the composer that splices models.json must be the caller; the walk named ${JSON.stringify(seam.callers)}`,
  );
});
