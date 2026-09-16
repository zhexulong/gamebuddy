import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkChatConversationalQualityGate,
  computeStringDivergence,
  evaluateLorebookTriggerPrecision,
  evaluateMemorySupersededAntiHallucination,
  evaluatePrefixBitStability,
  evaluateSemanticMemoryRetention,
  extractM0StableContext,
  extractM1VolatileContext,
  extractVolatileSourceIds,
  parseCliArgs,
  sha256,
} from "./check-chat-conversational-quality-gate.mjs";

const CLI_PATH = fileURLToPath(new URL("check-chat-conversational-quality-gate.mjs", import.meta.url));

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "gamebuddy-conv-gate-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function createStableContextXml(
  canonicalHash = "a".repeat(64),
  personaContent = "You are Emily, an empathetic companion.",
) {
  return [
    `<gamebuddy-authored-context version="v2" continuity-id="cont_01" session-id="sess_01" thread-id="thread_01" canonical-hash="${canonicalHash}">`,
    `<gamebuddy-authored-source kind="persona" source-id="persona-emily" revision="rev_01" canonical-hash="${sha256(personaContent)}">`,
    personaContent,
    `</gamebuddy-authored-source>`,
    `<gamebuddy-authored-source kind="scenario" source-id="scenario-saloon" revision="rev_01" canonical-hash="${sha256("At the Stardrop Saloon.")}">`,
    "At the Stardrop Saloon.",
    `</gamebuddy-authored-source>`,
    `</gamebuddy-authored-context>`,
  ].join("\n");
}

function createVolatileContextXml(sourceId, content) {
  return [
    `<gamebuddy-volatile-context canonical-hash="${sha256(content)}">`,
    `<gamebuddy-volatile-source source-id="${sourceId}" revision="rev_v01" canonical-hash="${sha256(content)}">`,
    content,
    `</gamebuddy-volatile-source>`,
    `</gamebuddy-volatile-context>`,
  ].join("\n");
}

// ==============================================================================
// 1. M0 前缀缓存比特级稳定性门禁 (Prefix Bit-Stability)
// ==============================================================================
test("Prefix Bit-Stability: passes when M0 is 100% byte-for-byte identical across all turns", () => {
  const m0Xml = createStableContextXml();
  const transcript = {
    turns: [
      { turnIndex: 1, m0StableContextXml: m0Xml },
      { turnIndex: 2, m0StableContextXml: m0Xml },
      { turnIndex: 3, m0StableContextXml: m0Xml },
      { turnIndex: 4, m0StableContextXml: m0Xml },
    ],
  };

  const result = evaluatePrefixBitStability(transcript);
  assert.equal(result.verdict, "passed");
  assert.equal(result.evaluatedTurns, 4);
  assert.equal(result.violations.length, 0);
  assert.equal(result.baselineSha256, sha256(m0Xml));
});

test("Prefix Bit-Stability: fails when attribute order or space drifts between turns", () => {
  const m0Baseline = createStableContextXml();
  // Drift: modify attribute order in root tag on turn 3
  const m0Drifted = m0Baseline.replace('version="v2" continuity-id="cont_01"', 'continuity-id="cont_01" version="v2"');

  const transcript = {
    turns: [
      { turnIndex: 1, m0StableContextXml: m0Baseline },
      { turnIndex: 2, m0StableContextXml: m0Baseline },
      { turnIndex: 3, m0StableContextXml: m0Drifted },
    ],
  };

  const result = evaluatePrefixBitStability(transcript);
  assert.equal(result.verdict, "failed");
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].code, "m0_hash_divergence");
  assert.equal(result.violations[0].turnIndex, 3);
  assert.ok(result.violations[0].divergence);
  assert.equal(result.violations[0].divergence.line, 1);
});

test("Prefix Bit-Stability: fails when Windows CRLF newline drift is present", () => {
  const m0Baseline = createStableContextXml();
  const m0WithCrLf = m0Baseline.replaceAll("\n", "\r\n");

  const transcript = {
    turns: [
      { turnIndex: 1, m0StableContextXml: m0Baseline },
      { turnIndex: 2, m0StableContextXml: m0WithCrLf },
    ],
  };

  const result = evaluatePrefixBitStability(transcript);
  assert.equal(result.verdict, "failed");
  assert.ok(result.violations.some((v) => v.code === "m0_carriage_return_detected"));
});

test("Prefix Bit-Stability: fails when M0 is polluted with volatile lorebook tags", () => {
  const m0Baseline = createStableContextXml();
  const m0Polluted = `${m0Baseline}\n<gamebuddy-volatile-source source-id="leaked" revision="1" canonical-hash="a">\npollution\n</gamebuddy-volatile-source>`;

  const transcript = {
    turns: [
      { turnIndex: 1, m0StableContextXml: m0Baseline },
      { turnIndex: 2, m0StableContextXml: m0Polluted },
    ],
  };

  const result = evaluatePrefixBitStability(transcript);
  assert.equal(result.verdict, "failed");
  assert.ok(result.violations.some((v) => v.code === "m0_volatile_pollution"));
});

test("Prefix Bit-Stability: fails closed when M0 context is missing on any turn", () => {
  const m0Baseline = createStableContextXml();
  const transcript = {
    turns: [
      { turnIndex: 1, m0StableContextXml: m0Baseline },
      { turnIndex: 2, playerInput: "Where is M0?" },
    ],
  };

  const result = evaluatePrefixBitStability(transcript);
  assert.equal(result.verdict, "failed");
  assert.ok(result.violations.some((v) => v.code === "m0_missing_in_turn" && v.turnIndex === 2));
});

// ==============================================================================
// 2. 长程延迟针式检索留存门禁 (Semantic Memory Retention)
// ==============================================================================
test("Semantic Memory Retention: passes when needle is accurately recalled across distractor turns", () => {
  const transcript = {
    turns: [
      { turnIndex: 1, playerInput: "Hi Emily", modelResponse: "Hello there!" },
      {
        turnIndex: 2,
        playerInput: "My grandmother taught me how to bake blackberry cobbler with a pinch of cardamom.",
        modelResponse: "That sounds delicious! Cardamom adds such a warm aroma to blackberry cobbler.",
      },
      { turnIndex: 3, playerInput: "The farm water pump is leaking.", modelResponse: "Check the rubber gasket." },
      { turnIndex: 4, playerInput: "It is raining heavily today.", modelResponse: "Stay warm inside!" },
      { turnIndex: 5, playerInput: "A stray orange cat showed up at the barn.", modelResponse: "Did you feed it?" },
      {
        turnIndex: 6,
        playerInput: "Do you remember the dessert recipe my grandmother taught me?",
        modelResponse:
          "Of course! Your grandmother taught you how to bake blackberry cobbler, and the special secret was a pinch of cardamom.",
        expectations: {
          needleFact: {
            needleId: "needle_grandma_cobbler",
            requiredKeywords: ["blackberry cobbler", "cardamom"],
            forbiddenKeywords: ["water pump", "stray cat"],
          },
        },
      },
    ],
  };

  const result = evaluateSemanticMemoryRetention(transcript);
  assert.equal(result.verdict, "passed");
  assert.equal(result.passedProbes, 1);
  assert.equal(result.recallRate, 1.0);
  assert.equal(result.violations.length, 0);
});

test("Semantic Memory Retention: fails when model misses key semantic keywords", () => {
  const transcript = {
    turns: [
      {
        turnIndex: 6,
        playerInput: "Do you remember the dessert recipe?",
        modelResponse: "You mentioned your grandmother liked baking blackberry pie, I think?",
        expectations: {
          needleFact: {
            needleId: "needle_grandma_cobbler",
            requiredKeywords: ["blackberry cobbler", "cardamom"],
          },
        },
      },
    ],
  };

  const result = evaluateSemanticMemoryRetention(transcript);
  assert.equal(result.verdict, "failed");
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].code, "needle_semantic_recall_failed");
  assert.ok(result.violations[0].misses.includes("cardamom"));
});

test("Semantic Memory Retention: fails when model confuses needle with distractor facts", () => {
  const transcript = {
    turns: [
      {
        turnIndex: 6,
        playerInput: "Do you remember the dessert recipe?",
        modelResponse: "Didn't your grandmother teach you how to fix the water pump on the farm?",
        expectations: {
          needleFact: {
            needleId: "needle_grandma_cobbler",
            requiredKeywords: ["blackberry cobbler", "cardamom"],
            forbiddenKeywords: ["water pump"],
          },
        },
      },
    ],
  };

  const result = evaluateSemanticMemoryRetention(transcript);
  assert.equal(result.verdict, "failed");
  assert.ok(result.violations.some((v) => v.code === "needle_distractor_confusion"));
});

// ==============================================================================
// 3. 记忆覆写与防旧设定幻觉门禁 (Memory Superseded Anti-Hallucination)
// ==============================================================================
test("Memory Superseded: passes dialogue and data checks when old fact is superseded and evicted", () => {
  const transcript = {
    turns: [
      {
        turnIndex: 1,
        playerInput: "I used to drink mint tea before bed.",
        modelResponse: "Mint tea is refreshing.",
      },
      {
        turnIndex: 3,
        playerInput: "Because of acid reflux, I completely quit mint tea. I now only drink roasted barley tea.",
        modelResponse: "Understood, health comes first! I noted that you quit mint tea and only drink barley tea now.",
      },
      {
        turnIndex: 6,
        playerInput: "I need a warm drink tonight. What would you recommend for me?",
        modelResponse:
          "I recommend a cup of warm roasted barley tea! It is soothing on the stomach and won't trigger acid reflux.",
        promptDump: "<memory>\n[Active Memory: Player exclusively drinks roasted barley tea before bed]\n</memory>",
        expectations: {
          memorySupersede: {
            testId: "supersede_tea_preference",
            oldFactContent: "mint tea",
            newFactContent: "barley tea",
            requiredNewKeywords: ["barley tea"],
            forbiddenOldKeywords: ["mint tea"],
          },
        },
      },
    ],
  };

  const dbMemories = [
    {
      id: 101,
      category: "semantic",
      content: "Player likes drinking mint tea before bed",
      status: "archived",
      superseded_by_memory_id: 102,
    },
    {
      id: 102,
      category: "semantic",
      content: "Player quit mint tea due to acid reflux, now drinks barley tea",
      status: "active",
      superseded_by_memory_id: null,
    },
  ];

  const result = evaluateMemorySupersededAntiHallucination(transcript, dbMemories);
  assert.equal(result.verdict, "passed");
  assert.equal(result.dialoguePassed, true);
  assert.equal(result.dataLevelPassed, true);
  assert.equal(result.violations.length, 0);
});

test("Memory Superseded: fails dialogue check when model hallucinates deprecated old fact", () => {
  const transcript = {
    turns: [
      {
        turnIndex: 6,
        playerInput: "What should I drink tonight?",
        modelResponse: "A nice cup of mint tea will help you sleep soundly!",
        expectations: {
          memorySupersede: {
            testId: "supersede_tea_preference",
            requiredNewKeywords: ["barley tea"],
            forbiddenOldKeywords: ["mint tea"],
          },
        },
      },
    ],
  };

  const result = evaluateMemorySupersededAntiHallucination(transcript);
  assert.equal(result.verdict, "failed");
  assert.ok(result.violations.some((v) => v.code === "superseded_old_fact_hallucinated"));
  assert.ok(result.violations.some((v) => v.code === "superseded_new_fact_missing"));
});

test("Memory Superseded: fails data check when old memory row remains active in SQLite", () => {
  const transcript = {
    turns: [
      {
        turnIndex: 6,
        modelResponse: "Enjoy your barley tea!",
        expectations: {
          memorySupersede: {
            testId: "supersede_tea_preference",
            oldFactContent: "mint tea",
            newFactContent: "barley tea",
            requiredNewKeywords: ["barley tea"],
            forbiddenOldKeywords: ["mint tea"],
          },
        },
      },
    ],
  };

  const dbMemoriesStale = [
    {
      id: 101,
      category: "semantic",
      content: "Player likes mint tea",
      status: "active", // Stale: should have been archived!
      superseded_by_memory_id: null,
    },
    {
      id: 102,
      category: "semantic",
      content: "Player drinks barley tea",
      status: "active",
      superseded_by_memory_id: null,
    },
  ];

  const result = evaluateMemorySupersededAntiHallucination(transcript, dbMemoriesStale);
  assert.equal(result.verdict, "failed");
  assert.ok(result.violations.some((v) => v.code === "superseded_old_record_still_active"));
});

test("Memory Superseded: fails context check when old fact leaks into prompt active memories", () => {
  const transcript = {
    turns: [
      {
        turnIndex: 6,
        modelResponse: "Here is your barley tea.",
        promptDump: "<memory>\n[Active Memory: User prefers mint tea]\n</memory>",
        expectations: {
          memorySupersede: {
            testId: "supersede_tea_preference",
            requiredNewKeywords: ["barley tea"],
            forbiddenOldKeywords: ["mint tea"],
          },
        },
      },
    ],
  };

  const result = evaluateMemorySupersededAntiHallucination(transcript);
  assert.equal(result.verdict, "failed");
  assert.ok(result.violations.some((v) => v.code === "superseded_memory_leaked_into_context"));
});

// ==============================================================================
// 4. 世界书/易变条目触发与退场精准度门禁 (Lorebook Trigger Precision)
// ==============================================================================
test("Lorebook Trigger Precision: passes on accurate trigger and clean eviction upon topic shift", () => {
  const transcript = {
    turns: [
      {
        turnIndex: 1,
        playerInput: "How is the weather today?",
        m1VolatileContextXml: "",
        expectations: {
          lorebook: { expectedTriggered: [], expectedEvicted: ["lore-herbalist"] },
        },
      },
      {
        turnIndex: 2,
        playerInput: "Where can I find the herbalist in the valley?",
        m1VolatileContextXml: createVolatileContextXml(
          "lore-herbalist",
          "The herbalist lives in a secluded tower in Cindersap Forest.",
        ),
        expectations: {
          lorebook: { expectedTriggered: ["lore-herbalist"], expectedEvicted: [] },
        },
      },
      {
        turnIndex: 3,
        playerInput: "Let's go fishing by the ocean docks.",
        m1VolatileContextXml: "",
        expectations: {
          lorebook: { expectedTriggered: [], expectedEvicted: ["lore-herbalist"] },
        },
      },
    ],
  };

  const result = evaluateLorebookTriggerPrecision(transcript);
  assert.equal(result.verdict, "passed");
  assert.equal(result.metrics.truePositives, 1);
  assert.equal(result.metrics.trueNegatives, 2);
  assert.equal(result.metrics.falsePositives, 0);
  assert.equal(result.metrics.falseNegatives, 0);
  assert.equal(result.metrics.precision, 1.0);
  assert.equal(result.metrics.recall, 1.0);
});

test("Lorebook Trigger Precision: fails when triggered entry is missing (False Negative)", () => {
  const transcript = {
    turns: [
      {
        turnIndex: 2,
        playerInput: "Tell me about the herbalist.",
        m1VolatileContextXml: "", // Missed trigger!
        expectations: {
          lorebook: { expectedTriggered: ["lore-herbalist"], expectedEvicted: [] },
        },
      },
    ],
  };

  const result = evaluateLorebookTriggerPrecision(transcript);
  assert.equal(result.verdict, "failed");
  assert.equal(result.metrics.falseNegatives, 1);
  assert.ok(result.violations.some((v) => v.code === "lorebook_trigger_missed"));
});

test("Lorebook Trigger Precision: fails when evicted entry lingers in M1 (False Positive / Stale Leak)", () => {
  const transcript = {
    turns: [
      {
        turnIndex: 3,
        playerInput: "Let's talk about fishing.",
        // Stale leak: lore-herbalist was NOT evicted
        m1VolatileContextXml: createVolatileContextXml("lore-herbalist", "The herbalist lives in Cindersap Forest."),
        expectations: {
          lorebook: { expectedTriggered: [], expectedEvicted: ["lore-herbalist"] },
        },
      },
    ],
  };

  const result = evaluateLorebookTriggerPrecision(transcript);
  assert.equal(result.verdict, "failed");
  assert.equal(result.metrics.falsePositives, 1);
  assert.ok(result.violations.some((v) => v.code === "lorebook_eviction_failed"));
});

// ==============================================================================
// 5. 辅助与工具函数单元测试
// ==============================================================================
test("computeStringDivergence detects exact difference offset and lines", () => {
  const strA = "hello\nworld\nfoo";
  const strB = "hello\nworld\nbar";
  const diff = computeStringDivergence(strA, strB);
  assert.ok(diff);
  assert.equal(diff.line, 3);
  assert.equal(diff.charExpected, '"f"');
  assert.equal(diff.charActual, '"b"');
});

test("extractM0StableContext extracts from promptDump or direct components", () => {
  const m0 = createStableContextXml();
  const turnWithDump = { promptDump: `System preamble\n${m0}\nTail prompt` };
  assert.equal(extractM0StableContext(turnWithDump), m0);

  const turnDirect = { m0StableContextXml: m0 };
  assert.equal(extractM0StableContext(turnDirect), m0);
});

test("extractM1VolatileContext extracts volatile context XML block", () => {
  const m1 = createVolatileContextXml("lore-shrine", "Shrine description");
  const turn = { m1VolatileContextXml: m1 };
  assert.equal(extractM1VolatileContext(turn), m1);

  const turnWithDump = { promptDump: `Leading text\n${m1}\nTrailing text` };
  assert.equal(extractM1VolatileContext(turnWithDump), m1);
});

test("extractVolatileSourceIds extracts all source IDs from M1 XML", () => {
  const m1 = [
    `<gamebuddy-volatile-context canonical-hash="123">`,
    `<gamebuddy-volatile-source source-id="lore-shrine" revision="1" canonical-hash="a">Shrine</gamebuddy-volatile-source>`,
    `<gamebuddy-volatile-source source-id="lore-wizard" revision="1" canonical-hash="b">Wizard</gamebuddy-volatile-source>`,
    `</gamebuddy-volatile-context>`,
  ].join("\n");

  const turn = { m1VolatileContextXml: m1 };
  assert.deepEqual(extractVolatileSourceIds(turn), ["lore-shrine", "lore-wizard"]);
});

test("parseCliArgs correctly parses flags", () => {
  const args = parseCliArgs([
    "node",
    "script.mjs",
    "--transcript=data/test.json",
    "--db",
    "data/context.db",
    "--report=report.json",
    "--json",
    "--require-db",
  ]);
  assert.equal(args.transcriptPath, "data/test.json");
  assert.equal(args.dbPath, "data/context.db");
  assert.equal(args.reportPath, "report.json");
  assert.equal(args.format, "json");
  assert.equal(args.requireDatabase, true);
});

// ==============================================================================
// 6. 端到端综合评测 (Golden Transcript & Live SQLite)
// ==============================================================================
test("End-to-End: Golden Transcript passes all 4 dimensions simultaneously", async () => {
  const m0 = createStableContextXml();
  const goldenTranscript = {
    schemaVersion: 1,
    metadata: {
      sessionId: "sess_golden_01",
      scenario: "Golden multi-turn benchmark",
    },
    turns: [
      // Turn 1: Initialization
      {
        turnIndex: 1,
        playerInput: "Hello Emily!",
        modelResponse: "Hello! Nice to see you at the saloon.",
        m0StableContextXml: m0,
        m1VolatileContextXml: "",
      },
      // Turn 2: Needle Fact + Old Fact Injection
      {
        turnIndex: 2,
        playerInput:
          "My grandmother taught me how to bake blackberry cobbler with cardamom. Also, I love drinking mint tea before bed.",
        modelResponse:
          "I will remember that! Cardamom gives blackberry cobbler such a wonderful taste, and mint tea is nice and calming.",
        m0StableContextXml: m0,
        m1VolatileContextXml: "",
      },
      // Turn 3: Lorebook Trigger (Herbalist)
      {
        turnIndex: 3,
        playerInput: "Where can I find the herbalist in the valley?",
        modelResponse: "The herbalist lives in a secluded tower in Cindersap Forest, southwest of here.",
        m0StableContextXml: m0,
        m1VolatileContextXml: createVolatileContextXml(
          "lore-herbalist",
          "The herbalist lives in a secluded tower in Cindersap Forest.",
        ),
        expectations: {
          lorebook: { expectedTriggered: ["lore-herbalist"], expectedEvicted: [] },
        },
      },
      // Turn 4: Eviction (Fishing) + Memory Override (Quit mint tea, now drink barley tea)
      {
        turnIndex: 4,
        playerInput:
          "Thanks! Let's go fishing by the docks. Also, because of acid reflux, I completely quit mint tea; I only drink roasted barley tea now.",
        modelResponse: "Good to know! Health comes first: no more mint tea, only roasted barley tea from now on.",
        m0StableContextXml: m0,
        m1VolatileContextXml: "",
        expectations: {
          lorebook: { expectedTriggered: [], expectedEvicted: ["lore-herbalist"] },
        },
      },
      // Turn 5: Distractor 1
      {
        turnIndex: 5,
        playerInput: "The farm water pump seems clogged with river silt.",
        modelResponse: "Make sure to clean the intake valve before turning it on.",
        m0StableContextXml: m0,
        m1VolatileContextXml: "",
      },
      // Turn 6: Distractor 2
      {
        turnIndex: 6,
        playerInput: "An orange stray cat was sheltering from the rain by the barn.",
        modelResponse: "Aww, cats always know the warmest spots on the farm.",
        m0StableContextXml: m0,
        m1VolatileContextXml: "",
      },
      // Turn 7: Delayed Needle Probe (Dimension 2)
      {
        turnIndex: 7,
        playerInput: "Do you remember the dessert recipe my grandmother taught me?",
        modelResponse:
          "Yes! Your grandmother taught you how to bake blackberry cobbler, with that signature pinch of cardamom.",
        m0StableContextXml: m0,
        m1VolatileContextXml: "",
        expectations: {
          needleFact: {
            needleId: "needle_grandma_cobbler",
            requiredKeywords: ["blackberry cobbler", "cardamom"],
            forbiddenKeywords: ["water pump", "stray cat"],
          },
        },
      },
      // Turn 8: Memory Superseded Probe (Dimension 3)
      {
        turnIndex: 8,
        playerInput: "What warm tea would you recommend for me tonight?",
        modelResponse:
          "I recommend a cup of warm roasted barley tea! It is soothing and gentle on the stomach, and won't trigger acid reflux.",
        m0StableContextXml: m0,
        m1VolatileContextXml: "",
        promptDump: "<memory>\n[Active: Player exclusively drinks roasted barley tea]\n</memory>",
        expectations: {
          memorySupersede: {
            testId: "supersede_tea_preference",
            oldFactContent: "mint tea",
            newFactContent: "barley tea",
            requiredNewKeywords: ["barley tea"],
            forbiddenOldKeywords: ["mint tea"],
          },
        },
      },
    ],
    dbSnapshot: {
      memories: [
        {
          id: 1,
          category: "semantic",
          content: "Player used to drink mint tea before bed",
          status: "archived",
          superseded_by_memory_id: 2,
        },
        {
          id: 2,
          category: "semantic",
          content: "Player quit mint tea due to acid reflux and now drinks roasted barley tea",
          status: "active",
          superseded_by_memory_id: null,
        },
      ],
    },
  };

  const gateResult = await checkChatConversationalQualityGate({ transcript: goldenTranscript });
  assert.equal(gateResult.verdict, "passed");
  assert.equal(gateResult.summary.dimensionsPassed, 4);
  assert.equal(gateResult.summary.dimensionsFailed, 0);
  assert.equal(gateResult.summary.totalViolations, 0);
});

test("End-to-End: Real SQLite DatabaseSync verification with live schema", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "test-context.db");
    const db = new DatabaseSync(dbPath);

    db.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        normalized_hash TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        superseded_by_memory_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    const insertStmt = db.prepare(`
      INSERT INTO memories (id, project_path, category, content, normalized_hash, status, superseded_by_memory_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    insertStmt.run(
      1,
      "/test",
      "semantic",
      "Player likes mint tea",
      "hash1",
      "archived",
      2,
      Date.now() - 1000,
      Date.now() - 500,
    );
    insertStmt.run(
      2,
      "/test",
      "semantic",
      "Player drinks barley tea",
      "hash2",
      "active",
      null,
      Date.now() - 500,
      Date.now(),
    );
    db.close();

    const transcript = {
      turns: [
        {
          turnIndex: 1,
          m0StableContextXml: createStableContextXml(),
          modelResponse: "Enjoy your barley tea!",
          expectations: {
            memorySupersede: {
              testId: "test_db_supersede",
              oldFactContent: "mint tea",
              newFactContent: "barley tea",
              requiredNewKeywords: ["barley tea"],
              forbiddenOldKeywords: ["mint tea"],
            },
          },
        },
      ],
    };

    const gateResult = await checkChatConversationalQualityGate({
      transcript,
      dbPath,
      options: { requireDatabase: true },
    });

    assert.equal(gateResult.verdict, "passed");
    assert.equal(gateResult.dimensions.memorySupersededAntiHallucination.dataLevelPassed, true);
  });
});

test("End-to-End: CLI returns exit code 0 on golden transcript and 1 on failing transcript", async () => {
  await withTempDir(async (dir) => {
    const validTranscriptPath = join(dir, "valid.json");
    const m0 = createStableContextXml();
    const validTranscript = {
      turns: [
        { turnIndex: 1, m0StableContextXml: m0, modelResponse: "Hello" },
        { turnIndex: 2, m0StableContextXml: m0, modelResponse: "World" },
      ],
    };
    await writeFile(validTranscriptPath, JSON.stringify(validTranscript), "utf8");

    // Valid run -> exit code 0
    const reportPath = join(dir, "report.json");
    const stdout = execFileSync(
      process.execPath,
      [CLI_PATH, `--transcript=${validTranscriptPath}`, `--report=${reportPath}`, "--json"],
      {
        encoding: "utf8",
      },
    );
    const parsedReport = JSON.parse(stdout);
    assert.equal(parsedReport.verdict, "passed");

    // Invalid run (cache drift) -> exit code 1
    const invalidTranscriptPath = join(dir, "invalid.json");
    const invalidTranscript = {
      turns: [
        { turnIndex: 1, m0StableContextXml: m0, modelResponse: "Hello" },
        { turnIndex: 2, m0StableContextXml: `${m0} `, modelResponse: "World with extra space" },
      ],
    };
    await writeFile(invalidTranscriptPath, JSON.stringify(invalidTranscript), "utf8");

    assert.throws(
      () => {
        execFileSync(process.execPath, [CLI_PATH, `--transcript=${invalidTranscriptPath}`], { encoding: "utf8" });
      },
      (err) => err.status === 1,
    );

    // Missing args -> exit code 2
    assert.throws(
      () => {
        execFileSync(process.execPath, [CLI_PATH], { encoding: "utf8" });
      },
      (err) => err.status === 2,
    );
  });
});
