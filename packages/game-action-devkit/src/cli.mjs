import path from "node:path";
import { runActionProject } from "./project-runner.mjs";

const OPTION_TO_FIELD = new Map([
  ["--project", "projectFile"],
  ["--action", "actionId"],
  ["--profile", "profileFile"],
  ["--brief", "briefFile"],
]);
const COMMANDS = new Set(["check", "preflight", "run-live", "status"]);
export const DEFAULT_PROJECT_FILE_NAME = "game-action-project.json";
export const MAX_CLI_STDOUT_BYTES = 64 * 1024;
export const MAX_CLI_REPORT_BYTES = MAX_CLI_STDOUT_BYTES - 1;

function fail(code) {
  throw new Error(`game_action_cli_${code}`);
}

export function parseGameActionArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail("invalid_arguments");
  const values = {};
  let command;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (OPTION_TO_FIELD.has(argument)) {
      const field = OPTION_TO_FIELD.get(argument);
      const value = args[index + 1];
      if (values[field] !== undefined || value === undefined || value.startsWith("--")) fail(`invalid_${field}`);
      values[field] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) fail("unknown_option");
    if (command !== undefined || !COMMANDS.has(argument)) fail("invalid_command");
    command = argument;
  }
  if (command === undefined) fail("missing_command");
  const projectFile = values.projectFile ?? path.resolve(process.cwd(), DEFAULT_PROJECT_FILE_NAME);
  const invocation = { command };
  for (const field of ["actionId", "profileFile", "briefFile"]) {
    if (values[field] !== undefined) invocation[field] = values[field];
  }
  return Object.freeze({ projectFile, invocation: Object.freeze(invocation) });
}

export function serializeCliReport(report) {
  let text;
  try { text = JSON.stringify(report); } catch { fail("report_unserializable"); }
  if (typeof text !== "string") fail("report_unserializable");
  if (Buffer.byteLength(text, "utf8") > MAX_CLI_REPORT_BYTES) fail("report_too_large");
  return text;
}

export async function runGameActionCli(args, { run = runActionProject } = {}) {
  const input = parseGameActionArgs(args);
  return run(input);
}
