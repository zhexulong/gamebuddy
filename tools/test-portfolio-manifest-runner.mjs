#!/usr/bin/env node
/** Repository-owned, shell-free CI portfolio runner. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readAndValidateTestPortfolioManifest } from "./test-portfolio-manifest.mjs";

const manifestDefault = resolve(import.meta.dirname, "../.ci/test-portfolio-manifest.v1.json");
const fail = (code) => {
  throw new Error(`portfolio_runner_${code}`);
};
const safePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/.test(value) &&
  !value.split("/").some((part) => part === "" || part === "." || part === "..");

export async function gitNames(root, args) {
  return await new Promise((resolveOutput, rejectOutput) => {
    const child = spawn("git", args, { cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.once("error", rejectOutput);
    child.once("close", (code) =>
      code === 0
        ? resolveOutput(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean))
        : rejectOutput(new Error("portfolio_runner_git_failed")),
    );
  });
}

export function processTreeTerminationCommand(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) fail("process_id_invalid");
  return platform === "win32" ? { executable: "taskkill", args: ["/PID", String(pid), "/T", "/F"] } : null;
}

function waitForClose(child) {
  return new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
}

function ignoreMissingProcess(error) {
  if (error?.code !== "ESRCH") throw error;
}

/**
 * Terminate the complete process tree without invoking a shell. POSIX children
 * are put in their own process group by execute(); Windows uses taskkill's
 * explicit tree switch because child.kill() only targets the direct child.
 */
export async function terminateProcessTree(
  child,
  { platform = process.platform, spawnProcess = spawn, killProcess = process.kill, wait = delay, graceMs = 250 } = {},
) {
  if (!child?.pid) return;
  const command = processTreeTerminationCommand(child.pid, platform);
  if (command) {
    const killer = spawnProcess(command.executable, command.args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    await waitForClose(killer);
    return;
  }

  try {
    killProcess(-child.pid, "SIGTERM");
  } catch (error) {
    ignoreMissingProcess(error);
  }
  await wait(graceMs);
  try {
    killProcess(-child.pid, "SIGKILL");
  } catch (error) {
    ignoreMissingProcess(error);
  }
}

export function changedPathGitArgs(event) {
  if (event.kind === "pull_request") return ["diff", "--name-only", "-z", event.base, event.head];
  if (event.before === "0".repeat(40))
    return ["diff-tree", "--root", "--no-commit-id", "--name-only", "-z", "-r", event.after];
  return ["diff", "--name-only", "-z", event.before, event.after];
}

export async function readChangedPaths(root, event) {
  return await gitNames(root, changedPathGitArgs(event));
}

export async function readCiEvent({
  eventName = process.env.GITHUB_EVENT_NAME,
  eventPath = process.env.GITHUB_EVENT_PATH,
} = {}) {
  if (eventName !== "pull_request" && eventName !== "push") fail("unsupported_event");
  if (typeof eventPath !== "string" || eventPath.length === 0) fail("event_data_missing");
  let event;
  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch {
    fail("event_data_invalid");
  }
  if (eventName === "pull_request") {
    if (
      !/^[0-9a-f]{40}$/.test(event?.pull_request?.base?.sha) ||
      !/^[0-9a-f]{40}$/.test(event?.pull_request?.head?.sha)
    )
      fail("event_data_invalid");
    return { kind: "pull_request", base: event.pull_request.base.sha, head: event.pull_request.head.sha };
  }
  if (event?.ref !== "refs/heads/main" || !/^[0-9a-f]{40}$/.test(event?.before) || !/^[0-9a-f]{40}$/.test(event?.after))
    fail("event_data_invalid");
  return { kind: "main", before: event.before, after: event.after };
}

export function selectEntries(manifest, { eventKind, changedPaths }) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0 || changedPaths.some((path) => !safePath(path)))
    fail("changed_paths_invalid");
  const changed = new Set(changedPaths);
  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const selected = new Map();
  const add = (entry) => {
    if (selected.has(entry.id)) return;
    selected.set(entry.id, entry);
    for (const dependency of entry.requires) {
      const required = byId.get(dependency);
      if (!required) fail("dependency_invalid");
      add(required);
    }
  };
  for (const entry of manifest.entries) {
    const target = eventKind === "main" ? "main" : eventKind;
    if (entry.requiredOn.includes(target) && entry.triggerPaths.some((path) => changed.has(path))) add(entry);
  }
  return [...selected.values()];
}

function splitCommand(command) {
  if (typeof command !== "string" || /[;&|<>`$()\\'"]/.test(command)) fail("unsafe_command");
  const tokens = command.trim().split(/\s+/u);
  if (tokens.length === 0 || !["node", "pnpm"].includes(tokens[0])) fail("executable_not_allowlisted");
  const unsafe = [
    "-e",
    "--eval",
    "-p",
    "--print",
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--inspect",
    "--inspect-brk",
    "--inspect-port",
    "--debug",
    "--debug-brk",
    "--debug-port",
  ];
  if (
    tokens
      .slice(1)
      .some(
        (token) =>
          unsafe.includes(token.split("=", 1)[0]) ||
          unsafe.some(
            (flag) => flag.length === 2 && token.startsWith(flag) && token !== flag && !token.startsWith(`${flag}=`),
          ),
      )
  )
    fail("module_loader_eval_inspect_forbidden");
  return { executable: tokens[0], args: tokens.slice(1) };
}

async function execute(entry) {
  const { executable, args } = splitCommand(entry.command);
  let last;
  for (let attempt = 1; attempt <= entry.retryPolicy.maxAttempts; attempt += 1) {
    try {
      await new Promise((resolveRun, rejectRun) => {
        const child = spawn(executable, args, {
          detached: process.platform !== "win32",
          shell: false,
          windowsHide: true,
          stdio: "inherit",
        });
        let timedOut = false;
        let termination;
        const timer = setTimeout(() => {
          timedOut = true;
          termination = terminateProcessTree(child).catch(() => undefined);
        }, entry.timeoutSeconds * 1000);
        child.once("error", rejectRun);
        child.once("close", async (code, signal) => {
          clearTimeout(timer);
          if (termination) await termination;
          if (timedOut) rejectRun(new Error("timeout"));
          else if (code !== 0) rejectRun(new Error(`exit_${code ?? signal}`));
          else resolveRun();
        });
      });
      return;
    } catch (error) {
      last = error;
      if (attempt < entry.retryPolicy.maxAttempts) await delay(entry.retryPolicy.backoffSeconds * 1000);
    }
  }
  throw new Error(`${entry.id}:${last?.message ?? "failed"}`);
}

export async function runPortfolio({
  manifestPath = manifestDefault,
  repositoryRoot = resolve(import.meta.dirname, ".."),
  eventName,
  eventPath,
} = {}) {
  const validation = await readAndValidateTestPortfolioManifest(manifestPath, repositoryRoot);
  if (!validation.valid) fail(`manifest_invalid:${validation.errors.join(",")}`);
  const event = await readCiEvent({ eventName, eventPath });
  const changed =
    event.kind === "pull_request"
      ? await gitNames(repositoryRoot, ["diff", "--name-only", "-z", event.base, event.head])
      : await readChangedPaths(repositoryRoot, event);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const selected = selectEntries(manifest, { eventKind: event.kind, changedPaths: changed });
  for (const entry of selected) if (entry.command !== null) await execute(entry);
  return { event: event.kind, changedPaths: changed, selected: selected.map((entry) => entry.id) };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runPortfolio(), null, 2));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
