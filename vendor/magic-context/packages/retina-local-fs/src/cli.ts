#!/usr/bin/env bun

import { ProviderError, runProvider } from "./provider";

async function main(): Promise<void> {
    try {
        const input = JSON.parse(await Bun.stdin.text()) as unknown;
        const output = await runProvider(input);
        process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
        const providerError =
            error instanceof ProviderError
                ? error
                : new ProviderError(
                      "invalid_input",
                      error instanceof Error ? error.message : "Unknown provider error",
                  );
        process.stderr.write(
            `${JSON.stringify({ code: providerError.code, message: providerError.message })}\n`,
        );
        process.exitCode = 1;
    }
}

await main();
