// red-proof: inject  treating a seed whose readback lacks the fact as durable -> `AssertionError` true !== false
//   at tools/live-run/memory/run-memory-live-loop.test.mjs:248, the case that must stop before the next seed
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveScenario, scoreReply, seedMemory } from "./run-memory-live-loop.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..", "..");
const FIXTURES = join(repositoryRoot, "tools", "fixtures", "chat-run-audit", "memory-probes");

/** The probe manifest as the Chat loop reads it: text in, validated scenario facts out. */
async function readFixture(name) {
  return await readFile(join(FIXTURES, `${name}.json`), "utf8");
}

/**
 * Stamp a manifest the way its own generator does (`<name>.manifest.mjs`), so a
 * test can author a manifest the validator accepts without hand-writing a digest.
 *
 * The helper is proven against the real fixtures below: running it over an existing
 * manifest must reproduce that manifest's own digest, so it cannot drift from the
 * producer without failing here first.
 */
function withDigest(manifest) {
  const canonical = JSON.stringify({
    schema: manifest.schema,
    manifestId: manifest.manifestId,
    continuityTopology: manifest.continuityTopology,
    probes: manifest.probes,
  });
  return Object.freeze({ ...manifest, manifestDigest: createHash("sha256").update(canonical).digest("hex") });
}

async function withManifestText(text, run) {
  const root = await mkdtemp(join(tmpdir(), "memory-loop-manifest-"));
  try {
    const path = join(root, "probe.json");
    await writeFile(path, text, "utf8");
    return await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// resolveScenario
// ---------------------------------------------------------------------------

test("with no manifest the inline seed and question are used, with the retention scoring rule", async () => {
  const scenario = await resolveScenario({ seed: "I kept bees.", question: "What did I keep?" });
  assert.deepEqual(scenario.seeds, ["I kept bees."]);
  assert.equal(scenario.seed, "I kept bees.");
  assert.equal(scenario.question, "What did I keep?");
  assert.equal(scenario.dimension, "retention");
  assert.equal(scenario.distance, "turn");
  assert.equal(scenario.minHitRate, 0.5);
  assert.equal(scenario.probeId, undefined);
  assert.equal(scenario.manifestDigest, undefined);
  // The inline branch declares no fillers at all: a caller that reads
  // `scenario.fillers ?? []` is what keeps a manifest-less run working, and this pins
  // that the caller's default is required rather than decorative.
  assert.equal(scenario.fillers, undefined);
});

test("with no manifest and no caller text the defaults are complete enough to run", async () => {
  const scenario = await resolveScenario({});
  assert.equal(scenario.seeds.length, 1);
  // The inline default must satisfy its own keyword rule, or the fallback scenario
  // scores a miss against itself.
  assert.ok(scenario.requiredKeywords.some((keyword) => scenario.seed.toLowerCase().includes(keyword)));
});

test("a manifest's seed, question, distance and every scoring knob survive into the scenario", async () => {
  const scenario = await resolveScenario({ manifestPath: join(FIXTURES, "turn-short.json") });
  assert.equal(scenario.probeId, "p-turn-short");
  assert.equal(scenario.dimension, "retention");
  assert.equal(scenario.distance, "turn");
  assert.equal(scenario.question, "By the way — do you remember what I did before I retired?");
  assert.deepEqual(scenario.requiredKeywords, ["postman", "mail"]);
  assert.deepEqual(scenario.forbiddenKeywords, ["mine", "haul"]);
  assert.equal(scenario.minHitRate, 0.5);
  assert.match(scenario.manifestDigest, /^[a-f0-9]{64}$/);
});

test("EVERY seed step is kept - dropping one reports the consequence as a product result", async () => {
  // The regression this pins: taking only the first seed silently truncated
  // multi-seed fixtures, so the supersede fixture's overwrite never happened and
  // `supersede.fail/old_retained` was guaranteed.
  const scenario = await resolveScenario({ manifestPath: join(FIXTURES, "turn-short.json") });
  assert.equal(scenario.seeds.length, 2);
  assert.match(scenario.seeds[1], /mine road/u);
  // The fixture's filler steps are the distance the probe crosses; dropping them
  // measured a zero-distance conversation while reporting the declared distance.
  assert.equal(scenario.fillers.length, 4);
});

test("the seed carrying the asked-about fact is the one L2 compares against", async () => {
  // Position alone is wrong in both directions: retention puts the needle FIRST and
  // a distractor later; supersession puts the asked-about (overwriting) fact LAST.
  const retention = await resolveScenario({ manifestPath: join(FIXTURES, "turn-short.json") });
  assert.match(retention.seed, /postman/u);
  assert.match(retention.seeds[0], /postman/u);

  const supersession = await resolveScenario({ manifestPath: join(FIXTURES, "supersede-stress.json") });
  assert.match(supersession.seed, /amethyst/u);
});

test("supersession is modelled as replacement, because update is the only overwriting verb the route has", async () => {
  const scenario = await resolveScenario({ manifestPath: join(FIXTURES, "supersede-stress.json") });
  assert.equal(scenario.dimension, "supersession");
  // The first seed is created; the second REPLACES it rather than being created
  // beside it, or both rows stay active and the forbidden set is unfalsifiable.
  assert.equal(scenario.seeds.length, 1);
  assert.match(scenario.seeds[0], /parsnips/u);
  assert.match(scenario.supersedes, /amethyst/u);
  // minHitRate comes from the fixture, never a hardcoded 0.5.
  assert.equal(scenario.minHitRate, 1);
});

test("a retention fixture with several seeds supersedes nothing", async () => {
  const scenario = await resolveScenario({ manifestPath: join(FIXTURES, "turn-short.json") });
  assert.equal(scenario.supersedes, undefined);
});

test("the fixture's declared distance survives, so a restart probe can report on the restart", async () => {
  const scenario = await resolveScenario({ manifestPath: join(FIXTURES, "restart.json") });
  assert.equal(scenario.distance, "session");
});

test("a manifest the loop cannot interpret is refused with a named code, never half-consumed", async () => {
  const single = JSON.parse(await readFixture("turn-short"));
  const twoProbes = withDigest({ ...single, probes: [...single.probes, { ...single.probes[0], probeId: "p-second" }] });
  await withManifestText(JSON.stringify(twoProbes), async (path) => {
    await assert.rejects(resolveScenario({ manifestPath: path }), /probe_fixture_multi_probe_unsupported/);
  });

  const noProbeStep = JSON.parse(await readFixture("turn-short"));
  noProbeStep.probes[0].steps = noProbeStep.probes[0].steps.filter((step) => step.kind !== "probe");
  await withManifestText(JSON.stringify(withDigest(noProbeStep)), async (path) => {
    await assert.rejects(resolveScenario({ manifestPath: path }), /probe_fixture_incomplete/);
  });

  const noSeeds = JSON.parse(await readFixture("turn-short"));
  noSeeds.probes[0].steps = noSeeds.probes[0].steps.filter((step) => step.kind !== "seed");
  await withManifestText(JSON.stringify(withDigest(noSeeds)), async (path) => {
    await assert.rejects(resolveScenario({ manifestPath: path }), /probe_fixture_incomplete/);
  });
});

test("the digest helper this suite authors manifests with is the producer's own rule", async () => {
  // Without this, the refusals above would only prove the helper agrees with itself.
  for (const name of ["turn-short", "supersede-stress", "restart"]) {
    const manifest = JSON.parse(await readFixture(name));
    assert.equal(withDigest(manifest).manifestDigest, manifest.manifestDigest, `${name}: digest drifted`);
  }
});

// ---------------------------------------------------------------------------
// seedMemory: the durable readback contract
// ---------------------------------------------------------------------------

const CLIENT = Object.freeze({ cookie: "session=test", csrf: "csrf-test" });

/**
 * A real HTTP server standing in for the mounted management surface.
 *
 * `readProjection` and `put` are the product's two answers this contract depends
 * on: the projection revision read before every write, and the write response
 * that IS the re-read of the store.
 */
async function withMemoryRoute({ readProjection, put }, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ method: request.method, body });
    const answer =
      request.method === "GET" ? { status: 200, payload: readProjection(requests.length) } : put(body, requests.length);
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.payload ?? {}));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

/** The management projection as the route returns it: rows plus the revision they were read at. */
const projection = (revision, rows) => ({ projectionRevision: revision, memories: rows });

test("the write response's own readback is the durability evidence", async () => {
  const SEED = "I retired after years of delivering the post.";
  let revision = 0;
  await withMemoryRoute(
    {
      readProjection: () => projection("rev-1", []),
      put: (body) => {
        revision += 1;
        return {
          status: 200,
          payload: projection(`rev-${revision + 1}`, [{ handle: "h-seed", content: body.content }]),
        };
      },
    },
    async (origin, requests) => {
      const result = await seedMemory(origin, CLIENT, [SEED]);
      assert.deepEqual(
        { durable: result.durable, rowCount: result.rowCount, seedHandle: result.seedHandle },
        { durable: true, rowCount: 1, seedHandle: "h-seed" },
      );
      // `projectionChanged` on the durable path reports that a CAS revision was
      // obtained at all (one cannot write without one); it is not a before/after
      // comparison, and the non-durable path below reports something else under the
      // same name. Asserted as the branch's own meaning, and flagged in the report.
      assert.equal(result.projectionChanged, true);
      // One read for the CAS revision, one write. No second query: the response IS the readback.
      assert.equal(requests.filter((entry) => entry.method === "GET").length, 1);
      assert.equal(requests.filter((entry) => entry.method === "PUT").length, 1);
    },
  );
});

test("a write whose readback lacks the fact is NOT durable, and stops before the next seed", async () => {
  // The consequence of continuing: later seeds are reported against a store that
  // never received the earlier ones, so a miss gets blamed on a layer the run never reached.
  let puts = 0;
  await withMemoryRoute(
    {
      readProjection: () => projection("rev-1", []),
      put: () => {
        puts += 1;
        // 200 with an unchanged revision and no matching row: the product re-read the
        // store and the fact is not in it.
        return { status: 200, payload: projection("rev-1", [{ handle: "h-other", content: "something else" }]) };
      },
    },
    async (origin) => {
      const result = await seedMemory(origin, CLIENT, ["first fact", "second fact"]);
      assert.equal(result.durable, false);
      assert.equal(result.rowCount, 1);
      assert.equal(puts, 1, "the second seed must not be written against an unproven store");
      // With an unchanged revision this reading is false under any spelling of it.
      assert.equal(result.projectionChanged, false);
    },
  );
});

test("a missing projection revision refuses the seed rather than writing blind", async () => {
  await withMemoryRoute({ readProjection: () => ({}), put: () => ({ status: 200, payload: {} }) }, async (origin) => {
    await assert.rejects(seedMemory(origin, CLIENT, ["fact"]), /projection_revision_unavailable/);
  });
});

test("a refused write carries the status, because a bare failure names no layer", async () => {
  await withMemoryRoute(
    {
      readProjection: () => projection("rev-1", []),
      put: () => ({ status: 503, payload: { code: "storage_unavailable" } }),
    },
    async (origin) => {
      await assert.rejects(seedMemory(origin, CLIENT, ["fact"]), /memory_seed_failed:503/);
    },
  );
});

test("several seeds are independent creates, and the durable handle is the FIRST one", async () => {
  let revision = 0;
  await withMemoryRoute(
    {
      readProjection: () => projection(`rev-${revision}`, []),
      put: (body) => {
        revision += 1;
        return {
          status: 200,
          payload: projection(`rev-${revision}`, [{ handle: `h-${revision}`, content: body.content }]),
        };
      },
    },
    async (origin, requests) => {
      const result = await seedMemory(origin, CLIENT, ["first fact", "second fact"]);
      assert.equal(result.durable, true);
      const writes = requests.filter((entry) => entry.method === "PUT").map((entry) => entry.body);
      assert.deepEqual(
        writes.map((body) => body.operation),
        ["create", "create"],
      );
      assert.equal(result.seedHandle, "h-1", "the handle kept is the one the first seed was written under");
    },
  );
});

test("supersession is an update of the row the earlier seed created, not a second create", async () => {
  const [OLD, NEW] = ["Parsnips are my favourite.", "Scratch that - amethyst now."];
  let revision = 0;
  await withMemoryRoute(
    {
      readProjection: () => projection(`rev-${revision}`, []),
      put: (body) => {
        revision += 1;
        return {
          status: 200,
          payload: projection(`rev-${revision}`, [{ handle: "h-topic", content: body.content }]),
        };
      },
    },
    async (origin, requests) => {
      const result = await seedMemory(origin, CLIENT, [OLD], NEW);
      assert.equal(result.durable, true);
      const writes = requests.filter((entry) => entry.method === "PUT").map((entry) => entry.body);
      assert.equal(writes.length, 2);
      assert.equal(writes[0].operation, "create");
      assert.equal(writes[0].content, OLD);
      assert.equal(writes[0].handle, undefined, "a create names no row to replace");
      // The route has no supersede verb: `update` is the operation that actually
      // overwrites, so the store ends with ONE active row for the topic.
      assert.deepEqual(
        { operation: writes[1].operation, handle: writes[1].handle, content: writes[1].content },
        { operation: "update", handle: "h-topic", content: NEW },
      );
      // Every write is a CAS against the revision read for that write.
      assert.equal(writes[1].expectedProjectionRevision, "rev-1");
      assert.equal(writes[2]?.expectedProjectionRevision, undefined);
    },
  );
});

test("a supersession with no row to replace refuses instead of creating a competing fact", async () => {
  // The readback carried no handle for the first seed, so there is nothing to update.
  // Creating the new fact instead would leave BOTH rows active.
  let revision = 0;
  await withMemoryRoute(
    {
      readProjection: () => projection(`rev-${revision}`, []),
      put: (body) => {
        revision += 1;
        return { status: 200, payload: projection(`rev-${revision}`, [{ content: body.content }]) };
      },
    },
    async (origin) => {
      await assert.rejects(seedMemory(origin, CLIENT, ["old fact"], "new fact"), /memory_supersede_handle_missing/);
    },
  );
});

// ---------------------------------------------------------------------------
// scoreReply: the frozen kernel rule, gated on THIS turn's durable commit
// ---------------------------------------------------------------------------

const RETENTION = Object.freeze({
  requiredKeywords: ["postman", "mail"],
  forbiddenKeywords: ["mine", "haul"],
  minHitRate: 0.5,
  dimension: "retention",
});

const committed = (text) => ({ turnState: "completed", committedCompanionDelta: 1, committedText: text });

test("a turn that never reached a terminal is an observability gap, never a scored miss", () => {
  const verdict = scoreReply({ committedText: undefined, scenario: RETENTION, chat: { turnState: null } });
  assert.deepEqual(verdict, { event: "observability_gap", reason: "probe_turn_not_terminal" });
});

test("a terminal turn that committed no new companion text is a gap, not a miss", () => {
  // The regression: the loop used to hardcode `gate: { ok: true }`, so a failed or
  // cancelled turn was scored as `needle.miss` and mis-attributed to a product layer.
  for (const turnState of ["failed", "cancelled", "completed"]) {
    const verdict = scoreReply({
      committedText: undefined,
      scenario: RETENTION,
      chat: { turnState, committedCompanionDelta: 0 },
    });
    assert.deepEqual(verdict, { event: "observability_gap", reason: "probe_turn_no_committed_presentation" });
  }
});

test("a committed reply that names the fact is a hit", () => {
  const verdict = scoreReply({
    committedText: "You were the postman, delivering the mail for years.",
    scenario: RETENTION,
    chat: committed("x"),
  });
  assert.deepEqual(verdict, { event: "needle.hit" });
});

test("a committed reply that does not name the fact is a miss", () => {
  const verdict = scoreReply({
    committedText: "I could not say - you have not told me.",
    scenario: RETENTION,
    chat: committed("x"),
  });
  assert.deepEqual(verdict, { event: "needle.miss" });
});

test("the two causes of distractor.confused stay distinguishable, because only one is a memory failure", () => {
  const recalled = scoreReply({
    committedText: "You were the postman, not the mine-road hauler.",
    scenario: RETENTION,
    chat: committed("x"),
  });
  assert.deepEqual(recalled, { event: "distractor.confused", reason: "needle_only" });

  const notRecalled = scoreReply({
    committedText: "You spent years hauling on the mine road.",
    scenario: RETENTION,
    chat: committed("x"),
  });
  assert.deepEqual(notRecalled, { event: "distractor.confused", reason: "recall_failed" });
});

test("the supersession dimension answers its own question, in both directions", () => {
  const scenario = Object.freeze({
    requiredKeywords: ["amethyst"],
    forbiddenKeywords: ["parsnip"],
    minHitRate: 1,
    dimension: "supersession",
  });
  assert.deepEqual(scoreReply({ committedText: "Amethyst, you said.", scenario, chat: committed("x") }), {
    event: "supersede.pass",
  });
  // The old fact surviving is the more specific failure: the overwrite never took
  // effect in the assembled prompt.
  assert.deepEqual(scoreReply({ committedText: "Parsnips, and amethyst too.", scenario, chat: committed("x") }), {
    event: "supersede.fail",
    reason: "old_retained",
  });
  assert.deepEqual(scoreReply({ committedText: "You never told me.", scenario, chat: committed("x") }), {
    event: "supersede.fail",
    reason: "new_missing",
  });
});

test("the gate short-circuits before any keyword is read", () => {
  // A gate that runs after scoring cannot prevent a miss being recorded; the reply
  // text is passed as undefined here, which the keyword rule would score as a miss.
  const verdict = scoreReply({ committedText: undefined, scenario: RETENTION, chat: { turnState: "failed" } });
  assert.equal(verdict.event, "observability_gap");
});

// ---------------------------------------------------------------------------
// Registration: the loop must be runnable and tested by name
// ---------------------------------------------------------------------------

test("the runner and this suite are registered as package scripts", async () => {
  const scripts = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).scripts;
  assert.equal(scripts["run:memory-live"], "node tools/live-run/memory/run-memory-live-loop.mjs");
  assert.equal(scripts["test:memory-live"], "node --test tools/live-run/memory/run-memory-live-loop.test.mjs");
});

// ---------------------------------------------------------------------------
// The shared verdict: the loop's own vocabulary stays, and the shared field is added
// ---------------------------------------------------------------------------

test("the memory loop publishes the shared run verdict beside its own funnel, and maps by status", async () => {
  // The loop's judgement is untouched - `attributeMemoryFunnel` still decides, and its per-stage rows
  // still carry `passed`/`broken`/`observability_gap`/`not_reached`. What the boundary adds is the ONE
  // field a comparison tool can read across the Game, Chat and Memory loops.
  const { buildMemoryRunVerdict } = await import("../core/run-verdict.mjs");
  const { attributeMemoryFunnel } = await import("../../lib/memory-funnel.mjs");

  // A seed that was never read back: L1 is a gap, and the rollup must be `unobserved` with L1's own
  // reason - not `verified` because the later stages were never exercised.
  const attributed = attributeMemoryFunnel({ seedRequired: true, seedPresentInReadback: false });
  const verdict = buildMemoryRunVerdict(attributed.stages);
  assert.equal(verdict.schema, "live_run_verdict/v1");
  assert.equal(verdict.state, "unobserved");
  assert.equal(verdict.reason, "seed_readback_unobserved");
  // The local status is preserved: a reader can still see WHICH stage was a gap.
  assert.equal(verdict.checks[0].id, "L1_write");
  assert.equal(verdict.checks[0].local, "observability_gap");

  // An unobserved run is never `passed` and never a zero-shaped reading.
  assert.notEqual(verdict.state, "verified");
});

test("the runner writes the shared verdict and never derives it from a lifecycle status", async () => {
  // A source-level assertion, because the failure it prevents is a WIRING regression: the mapping
  // exists, the report is written, and the line that publishes the verdict is silently dropped. The
  // second half is the one that matters most - deriving the verdict from `collected` would turn the
  // harness's own lifecycle fact into a clean bill, which is exactly the defect
  // `core/evidence-verdict.mjs` was written for.
  const source = await readFile(join(here, "run-memory-live-loop.mjs"), "utf8");
  assert.match(source, /import \{ buildMemoryRunVerdict, narrateRunVerdict \} from "\.\.\/core\/run-verdict\.mjs";/u);
  const calls = source.match(/buildMemoryRunVerdict\(attributed\.stages\)/gu) ?? [];
  assert.equal(calls.length, 3, "every report-writing branch must publish the shared verdict");
  assert.equal(
    /state:\s*"collected"/u.test(source),
    false,
    "a lifecycle status must never stand in for the shared verdict",
  );
});
