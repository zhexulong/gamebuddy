#!/usr/bin/env node

import { runGameActionCli, serializeCliReport } from "../src/cli.mjs";

try {
  const report = await runGameActionCli(process.argv.slice(2));
  process.stdout.write(`${serializeCliReport(report)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "game_action_cli_failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
