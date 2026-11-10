/*
 * red-proof: this file's assertions were each seen red once, on a real injected violation, with both
 * readings quoted:
 *
 *   the memory fact removed from the carried turn's body while its `<project-memory>` section stayed
 *   -> "all three claims are proven ..." red, `carried_direction_failed section_without_the_fact`;
 *   the world-book entry's prose added to the ABSENT turn's body
 *   -> "the world-book absent direction ..." red, `absent_direction_failed inWorldBookBlock=true`;
 *   `temperature` dropped from the carried turn's body
 *   -> `carried_direction_failed temperature=not-carried`.
 *
 * WHAT THE MACHINE CANNOT SAY, stated here so a green file is not read as a live measurement: every
 * body below is a FIXTURE shaped like the product's wire (an m[0] user message carrying the authored
 * catalogue and the memory directory, an m[1] carrying the volatile entries, sampling values as
 * top-level fields). What that proves is that the INSTRUMENT distinguishes the two directions - that a
 * capture which lost a fact reads as failed instead of as absent, and one that carries it reads as
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
const WORLDBOOK_ENTRY = "gbw3-worldbook-entry: the lighthouse keeper is called Maren";
const SAID = "gbw3-player-line";

const AUTHORED = (constant) =>
  `<gamebuddy-authored-context version="v2">\n<gamebuddy-authored-source kind="lorebook_constant">${constant}</gamebuddy-authored-source>\n</gamebuddy-authored-context>`;

/**
 * One provider request body, shaped as the product posts it.
 *
 * The authored catalogue rides a USER message (the cached prefix's m[0]) and the volatile entries the
 * message after it - a reading that only asked the system message would report the authored context
 * absent on a turn that carried it, which is the defect `observation.cjs` already paid for once.
 */
function bodyOf({ memory = null, entry = null, temperature = null }) {
  const head = [
    "<session-history></session-history>",
    memory === null ? "" : `<project-memory>\n${memory}\n</project-memory>`,
    AUTHORED("the valley premise"),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const volatile =
    entry === null
      ? ""
      : `<gamebuddy-volatile-context>\n<gamebuddy-volatile-source>\n${entry}\n</gamebuddy-volatile-source>\n</gamebuddy-volatile-context>`;
  return {
    model: "fixture-model",
    messages: [
      { role: "system", content: "the Host floor" },
      { role: "user", content: head },
      { role: "user", content: volatile.length === 0 ? SAID : `${volatile}\n${SAID}` },
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
  memory: { fact: MEMORY_FACT, turns: { carried, absent } },
  worldBook: { text: WORLDBOOK_ENTRY, turns: { carried, absent } },
  sampling: { key: "temperature", value: 0.9, turns: { carried, absent } },
});

const claimOf = (reading, name) => reading.claims.find((claim) => claim.name === name);

/** The bound turn, and the turn where nothing was bound. */
const boundRun = (overrides = {}) =>
  captureFile([
    {
      key: "key-bound",
      body: overrides.carried ?? bodyOf({ memory: MEMORY_FACT, entry: WORLDBOOK_ENTRY, temperature: 0.9 }),
    },
    { key: "key-unbound", body: overrides.absent ?? bodyOf({}) },
  ]);

test("all three claims are proven when the bound turn carries each fact and the unbound turn carries none", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun(),
    probe: probeFor("key-bound", "key-unbound"),
  });
  assert.equal(reading.ok, true, `capture must be readable: ${reading.reason}`);
  assert.deepEqual(
    reading.claims.map((claim) => `${claim.name}=${claim.verdict}`),
    ["memory=proven", "worldBook=proven", "sampling=proven"],
    `every claim needs both directions:\n${JSON.stringify(reading.claims, null, 1)}`,
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
      carried: bodyOf({ memory: "something else entirely", entry: WORLDBOOK_ENTRY, temperature: 0.9 }),
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
  const drifted = bodyOf({ entry: WORLDBOOK_ENTRY, temperature: 0.9 });
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
  assert.equal(worldBook.readings.absent.detail.inWorldBookBlock, true);
});

test("a preset value that is present but is another layer's is not carried", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ absent: bodyOf({ temperature: 0.7 }) }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const sampling = claimOf(reading, "sampling");
  assert.equal(sampling.verdict, "proven", "0.7 is not the preset's 0.9, so the unbound turn really does not carry it");
  assert.equal(sampling.readings.absent.detail.carried, true);
  assert.equal(sampling.readings.absent.detail.value, 0.7);
  assert.equal(sampling.readings.absent.detail.matches, false);
});

test("a sampling key missing from the bound turn fails that direction by name", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: boundRun({ carried: bodyOf({ memory: MEMORY_FACT, entry: WORLDBOOK_ENTRY }) }),
    probe: probeFor("key-bound", "key-unbound"),
  });
  const sampling = claimOf(reading, "sampling");
  assert.equal(sampling.verdict, "carried_direction_failed");
  assert.equal(sampling.readings.carried.state, "absent");
  assert.equal(sampling.readings.carried.detail.carried, false);
});

test("a turn with no record in the capture is unobserved, never absent", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: captureFile([
      { key: "key-bound", body: bodyOf({ memory: MEMORY_FACT, entry: WORLDBOOK_ENTRY, temperature: 0.9 }) },
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
  assert.equal(claimOf(reading, "sampling").verdict, "unobserved");
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

test("a capture that was never recorded is reported as a reason, not as three absent claims", async () => {
  const reading = await readClaimsFromCaptureFile({
    captureFile: join(tmpdir(), "no-such-capture-file.jsonl"),
    probe: probeFor("key-bound", "key-unbound"),
  });
  assert.equal(reading.ok, false);
  assert.match(reading.reason, /^no_provider_request_capture:capture_file_absent/u);
  assert.deepEqual(describeClaims("v", reading), [`INJECTION v: unobserved:${reading.reason}`]);
});
/* ---------- the sampling claim's named absence, and its expiry ---------- */

/**
 * The sampling claim reports `unobserved:no_preset_bound_to_runtime` on every run today, and a claim that
 * is allowed to say that forever is an alibi rather than a reading. So the reason is a MEASUREMENT: this
 * walks the Host's production sources for a caller of the preset-sampling seam and names it. The day one
 * appears the assertion goes red and the run must take the sampling reading instead of reporting it absent
 * - an exemption that expires by itself, on the code that ends it.
 *
 * The synthetic trees are how that is proved to work both ways without touching the Host: a planted caller
 * is found, the seam's own file is not counted as its own caller, and an unreadable root is "not measured"
 * rather than "nothing calls it".
 */
test("a planted caller of the preset-sampling seam is named, and the seam's own file is not its caller", () => {
  const root = mkdtempSync(join(tmpdir(), "preset-seam-"));
  mkdirSync(join(root, "tavern"), { recursive: true });
  writeFileSync(
    join(root, "tavern", "preset-sampling.ts"),
    "export function applyPresetSamplingToProviderEntry() { return 1; }\n",
    "utf8",
  );
  writeFileSync(join(root, "tavern", "preset-sampling.test.ts"), "applyPresetSamplingToProviderEntry();\n", "utf8");
  const before = presetSamplingCallers(root);
  assert.equal(before.ok, true);
  assert.deepEqual(before.callers, [], "the definition and its own test are not callers of the seam");

  writeFileSync(
    join(root, "runtime-core.internal.ts"),
    "import { applyPresetSamplingToProviderEntry } from './tavern/preset-sampling.js';\napplyPresetSamplingToProviderEntry(entry);\n",
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

test("the sampling claim's named absence still holds: nothing binds a preset to a chat's runtime", () => {
  const seam = presetSamplingCallers(join(import.meta.dirname, "..", "..", "..", "..", "host", "src"));
  assert.equal(seam.ok, true, `the Host's own sources must be readable for this reading: ${seam.reason}`);
  assert.ok(seam.files > 100, `examined ${seam.files} production file(s) - an empty walk proves nothing`);
  assert.deepEqual(
    seam.callers,
    [],
    `a preset is now bound to the runtime through ${seam.callers.join(", ")}: take the sampling claim's carried reading from a real turn instead of reporting it unobserved`,
  );
});
