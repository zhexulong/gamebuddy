#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const model = process.env.GAMEBUDDY_TRACE_MODEL ?? "deepseek-v4-flash";
const provider = process.env.GAMEBUDDY_TRACE_PROVIDER ?? "cpa-oai";
const thinking = process.env.GAMEBUDDY_TRACE_THINKING ?? "high";
const piCommand =
  process.env.PI_BIN ??
  (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local"), "pnpm", "bin", "pi.CMD")
    : "pi");
const keepTrace = process.env.GAMEBUDDY_KEEP_MODEL_TRACE === "1";

const extensionSource = `
import { appendFileSync } from "node:fs";
import { Type } from "typebox";

const tracePath = process.env.GAMEBUDDY_TRACE_PATH;
if (!tracePath) throw new Error("GAMEBUDDY_TRACE_PATH required");
const record = (tool, details, params) => appendFileSync(tracePath, JSON.stringify({ tool, details, ...(params === undefined ? {} : { params }) }) + "\\n", "utf8");
const result = (details) => ({ content: [{ type: "text", text: JSON.stringify(details) }], details });
let currentTool = "Axe";
let snapshotCalls = 0;

export default function (pi) {
  pi.registerTool({
    name: "game_snapshot",
    label: "Live Game Snapshot",
    description: "Read the authoritative current Stardew snapshot. This is the only source of current game facts.",
    parameters: Type.Object({}),
    execute: async () => {
      snapshotCalls += 1;
      const details = { revision: snapshotCalls === 1 ? 12 : 13, saveId: "save_trace", worldId: "world_trace", location: "Farm", currentTool, actionable: true, capabilities: ["equip_tool"], activeExecution: null };
      record("game_snapshot", details);
      return result(details);
    },
  });
  pi.registerTool({
    name: "stardew_game_knowledge",
    label: "Stardew Gameplay Knowledge",
    description: "Read version-bound advisory knowledge. It never grants permission and never replaces a live snapshot.",
    parameters: Type.Object({ capability: Type.String({ minLength: 1 }) }),
    execute: async (_id, params) => {
      const details = { kind: params.capability === "equip_tool" ? "supported" : "unknown", reasonCode: params.capability === "equip_tool" ? "knowledge_available" : "knowledge_not_available", gameVersion: "1.6.15", snapshotRevision: 12, liveCapability: params.capability === "equip_tool", rules: params.capability === "equip_tool" ? ["Only select a Tool already owned by the Farmhand; verify with a fresh snapshot and receipt."] : [] };
      record("stardew_game_knowledge", details, params);
      return result(details);
    },
  });
  pi.registerTool({
    name: "stardew_equip_tool",
    label: "Equip Tool",
    description: "Request one capability-authorized tool selection. The receipt is authoritative; accepted is not success.",
    parameters: Type.Object({ slot: Type.Integer({ minimum: 0, maximum: 36 }) }),
    execute: async (_id, params) => {
      const before = currentTool;
      const succeeds = params.slot === 3;
      const after = succeeds ? "Pickaxe" : before;
      if (succeeds) currentTool = after;
      const details = { executionId: "trace-execution-01", requestId: "trace-request-01", state: succeeds ? "succeeded" : "failed", reasonCode: succeeds ? "tool_selected" : "tool_not_owned_in_slot", revision: 13, evidence: { slot: params.slot, before, expected: succeeds ? "Pickaxe" : null, after } };
      record("stardew_equip_tool", details, params);
      return result(details);
    },
  });
  pi.registerTool({
    name: "todowrite",
    label: "Todo",
    description: "Maintain the Companion's current multi-step todo list. This trace tool records intent only; it does not execute game actions.",
    parameters: Type.Object({ todos: Type.Array(Type.Object({ content: Type.String({ minLength: 1 }), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]) })) }),
    execute: async (_id, params) => {
      record("todowrite", { todos: params.todos, source: "agent_trace" });
      return result({ todos: params.todos, source: "agent_trace" });
    },
  });
}
`;

async function resolvePiInvocation() {
  if (process.platform === "win32" && piCommand.toLowerCase().endsWith(".cmd")) {
    const shim = await readFile(piCommand, "utf8");
    const relativeTarget = shim.match(/"([^"]*pi-coding-agent[^"]*dist[^"]*cli\.js)"/i)?.[1];
    if (relativeTarget === undefined) throw new Error(`Unable to resolve Pi CLI target from ${piCommand}`);
    const target = resolve(dirname(piCommand), relativeTarget.replace(/^%~dp0[\\/]/, "").replaceAll("\\", "/"));
    await access(target);
    return { command: process.execPath, prefix: [target] };
  }
  await access(piCommand);
  return { command: piCommand, prefix: [] };
}

function runPi(invocation, extensionPath, tracePath) {
  return new Promise((resolveRun, rejectRun) => {
    const args = [
      "--no-session",
      "--no-extensions",
      "-e",
      extensionPath,
      "--no-tools",
      "--tools",
      "game_snapshot,stardew_game_knowledge,stardew_equip_tool,todowrite",
      "--provider",
      provider,
      "--model",
      model,
      "--thinking",
      thinking,
      "--mode",
      "json",
      "-p",
      [
        "You are running a controlled GameBuddy Agent model trace.",
        "Complete this open-ended two-step companion objective using only the supplied tools.",
        "First call game_snapshot, then query stardew_game_knowledge for equip_tool.",
        "If the live snapshot declares equip_tool and the knowledge is supported, use todowrite to track: selecting Pickaxe and verifying the authoritative receipt.",
        "Then call stardew_equip_tool with slot 3.",
        "After the action, call game_snapshot again and inspect the receipt.",
        "Only mark both todo items completed when the receipt state is succeeded and evidence contains before, expected, and after.",
        "Never treat accepted or running as success, never invent a receipt, and do not claim a game result without evidence.",
      ].join(" "),
    ];
    const child = spawn(invocation.command, [...invocation.prefix, ...args], {
      cwd: repoRoot,
      env: { ...process.env, GAMEBUDDY_TRACE_PATH: tracePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timeout = setTimeout(
      () => {
        child.kill();
        rejectRun(new Error("agent_model_trace_timeout"));
      },
      Number(process.env.GAMEBUDDY_TRACE_TIMEOUT_MS ?? 120_000),
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveRun({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

function summarize(rows) {
  const tools = rows.map((row) => row.tool);
  const firstSnapshot = rows.findIndex((row) => row.tool === "game_snapshot");
  const knowledge = rows.findIndex((row) => row.tool === "stardew_game_knowledge");
  const action = rows.findIndex((row) => row.tool === "stardew_equip_tool");
  const receipt = action >= 0 ? rows[action].details : undefined;
  const postSnapshot = rows.findIndex((row, index) => index > action && row.tool === "game_snapshot");
  const todos = rows.filter((row) => row.tool === "todowrite").at(-1)?.details?.todos ?? [];
  const evidence = receipt?.evidence;
  const evidenceComplete =
    evidence !== undefined &&
    ["before", "expected", "after"].every((key) => typeof evidence[key] === "string" && evidence[key].length > 0);
  const completed = Array.isArray(todos) && todos.length >= 2 && todos.every((todo) => todo.status === "completed");
  return {
    provider,
    model,
    thinking,
    toolOrder: tools,
    requiredOrder: firstSnapshot >= 0 && knowledge > firstSnapshot && action > knowledge && postSnapshot > action,
    receipt: receipt
      ? {
          state: receipt.state,
          reasonCode: receipt.reasonCode,
          executionId: receipt.executionId,
          requestId: receipt.requestId,
          evidence: receipt.evidence,
        }
      : null,
    evidenceComplete,
    todoCompleted: completed,
    passed:
      firstSnapshot >= 0 &&
      knowledge > firstSnapshot &&
      action > knowledge &&
      postSnapshot > action &&
      receipt?.state === "succeeded" &&
      evidenceComplete &&
      completed,
  };
}

let piInvocation;
try {
  piInvocation = await resolvePiInvocation();
} catch {
  throw new Error(
    `Pi executable not found or could not be resolved: ${piCommand}. Set PI_BIN to the configured pi executable.`,
  );
}

const tempRoot = await mkdtemp(join(tmpdir(), "gamebuddy-model-trace-"));
const extensionPath = join(repoRoot, "tools", `.agent-trace-${process.pid}.mjs`);
const tracePath = join(tempRoot, "tool-trace.jsonl");
try {
  await writeFile(extensionPath, extensionSource, "utf8");
  const run = await runPi(piInvocation, extensionPath, tracePath);
  const raw = await readFile(tracePath, "utf8").catch(() => "");
  const rows =
    raw.trim() === ""
      ? []
      : raw
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
  const summary = summarize(rows);
  const finalSummary = { ...summary, exitCode: run.code, passed: summary.passed && run.code === 0 };
  if (!finalSummary.passed) {
    console.error(JSON.stringify({ ...finalSummary, stderr: run.stderr.slice(-2_000) }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(finalSummary));
  }
  if (keepTrace) {
    const destination = resolve(
      process.env.GAMEBUDDY_MODEL_TRACE_OUTPUT ?? join(repoRoot, "tmp", `agent-model-trace-${Date.now()}.jsonl`),
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, raw, "utf8");
    console.error(`trace=${destination}`);
  }
} finally {
  await rm(extensionPath, { force: true });
  if (!keepTrace) await rm(tempRoot, { recursive: true, force: true });
}
