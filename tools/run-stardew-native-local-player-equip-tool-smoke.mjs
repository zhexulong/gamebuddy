import {
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  waitForStableRevision,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "equip_tool";

/** Load the emitted Host client from the local dist-test artifact. */
async function loadDistTestClient(entry) {
  const { LocalStardewBridgeClient } = await import(`../host/dist-test/${entry}`);
  return { LocalStardewBridgeClient };
}

/**
 * equip_tool/v2 semantic smoke: dispatch a canonical tool category and prove
 * the Mod resolved it deterministically on the game thread (native switch plus
 * ReferenceEquals postcondition). The fixture's starting inventory always owns
 * a basic Axe, so `axe` exercises the resolve path; the Mod may answer
 * tool_equipped or already_equipped, and evidence must satisfy
 * after_equals_expected per the frozen development contract.
 */
export async function runEquipToolSmoke(
  client,
  receipts,
  config,
  { toolCategory = "axe", terminalTimeoutMs = 30_000, postconditionTimeoutMs = 5_000 } = {},
) {
  try {
    const before = await observeFresh(client, { actionable: true });
    if (!before.capabilities.includes(ACTION)) throw new Error("native_local_equip_tool_capability_missing");
    if (!toolCategory || !/^[a-z][a-z0-9_]{0,63}$/.test(toolCategory)) throw new Error("invalid_tool_category");

    const requestId = `native_local_equip_tool_${Date.now()}`;
    const request = Object.freeze({
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: Object.freeze({ tool: toolCategory }),
      expectedRevision: before.revision,
    });
    const accepted = await executeFresh(client, {
      ...request,
      snapshot: before,
      timeoutMs: 30_000,
    });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.state !== "succeeded") throw new Error(`equip_failed:${terminal.reasonCode}`);
    if (terminal.reasonCode !== "tool_equipped" && terminal.reasonCode !== "already_equipped")
      throw new Error(`unexpected_equip_reason:${terminal.reasonCode}`);
    const evidence = parseEquipToolEvidence(terminal.evidence);
    const after = await waitForStableRevision(client, {
      revision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (snapshot) =>
        snapshot.actionable === true &&
        snapshot.activeExecution == null &&
        typeof snapshot.currentTool === "string" &&
        snapshot.currentTool.length > 0 &&
        snapshot.currentTool === evidence.after,
    });

    assertExactProof({ request, accepted, terminal, evidence, before, after });
    return {
      state: "passed",
      reasonCode: terminal.reasonCode,
      selected: { tool: toolCategory, resolvedLabel: evidence.after },
      request,
      accepted: { requestId: accepted.requestId, executionId: accepted.executionId },
      terminal: {
        requestId: terminal.requestId,
        executionId: terminal.executionId,
        state: terminal.state,
        reasonCode: terminal.reasonCode,
        revision: terminal.revision,
      },
      evidence,
      postcondition: {
        revision: after.revision,
        currentTool: after.currentTool,
        expectedTool: evidence.after,
        selected: { tool: toolCategory, resolvedLabel: evidence.after },
      },
    };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
    };
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const toolIndex = args.indexOf("--tool");
  const tool = toolIndex >= 0 && args[toolIndex + 1] && /^[a-z][a-z0-9_]{0,63}$/.test(args[toolIndex + 1])
    ? args[toolIndex + 1]
    : "axe";
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadDistTestClient });
  try {
    const result = await runEquipToolSmoke(session.client, session.receipts, config, { toolCategory: tool });
    const failed = result.state !== "passed";
    if (!failed) {
      console.log(JSON.stringify(result));
    } else {
      console.error(JSON.stringify(result));
      process.exitCode = 1;
    }
  } finally {
    await session.close();
  }
}

function parseEquipToolEvidence(evidence) {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("invalid_equip_tool_evidence");
  const detail = typeof evidence.detail === "string" ? evidence.detail : "";
  const entries = detail.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index <= 0) throw new Error("invalid_equip_tool_evidence");
    return [part.slice(0, index), part.slice(index + 1)];
  });
  const parsed = Object.fromEntries(entries);
  if (entries.length !== 4 || Object.keys(parsed).length !== 4 || !Object.hasOwn(parsed, "tool") || !Object.hasOwn(parsed, "before") || !Object.hasOwn(parsed, "expected") || !Object.hasOwn(parsed, "after")) throw new Error("invalid_equip_tool_evidence");
  if (typeof parsed.tool !== "string" || parsed.tool.length === 0 || [parsed.before, parsed.expected, parsed.after].some((value) => typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256)) throw new Error("invalid_equip_tool_evidence");
  return { tool: parsed.tool, before: parsed.before, expected: parsed.expected, after: parsed.after };
}

function assertExactProof({ request, accepted, terminal, evidence, before, after }) {
  if (accepted.requestId !== request.requestId || terminal.requestId !== request.requestId) throw new Error("equip_tool_request_id_mismatch");
  if (terminal.executionId !== accepted.executionId) throw new Error("equip_tool_execution_id_mismatch");
  if (!Number.isSafeInteger(terminal.revision) || terminal.revision <= request.expectedRevision || after.revision !== terminal.revision) throw new Error("equip_tool_revision_mismatch");
  if (evidence.tool !== request.args.tool) throw new Error("equip_tool_evidence_tool_mismatch");
  if (evidence.expected !== evidence.after) throw new Error("equip_tool_evidence_after_not_expected");
  if (after.currentTool !== evidence.after) throw new Error("equip_tool_postcondition_mismatch");
}