import { spawn } from "node:child_process";
import { runCompanionLiveCoop01 } from "./run-stardew-companion-live-coop-01.mjs";

const SMAPI_PATH = "D:\\Steam\\steamapps\\common\\Stardew Valley\\StardewModdingAPI.exe";
const SMAPI_CWD = "D:\\Steam\\steamapps\\common\\Stardew Valley";

async function main() {
  console.log(`Starting SMAPI from: ${SMAPI_PATH}`);
  const smapiProcess = spawn(SMAPI_PATH, [], {
    cwd: SMAPI_CWD,
    stdio: "inherit",
  });

  smapiProcess.on("exit", (code) => {
    console.log(`[SMAPI] Process exited with code ${code}`);
  });

  console.log("Connecting to GameBuddy bridge (waiting up to 90s for save to load)...");
  const result = await runCompanionLiveCoop01({ retries: 90 });
  console.log("Live run result:", JSON.stringify(result, null, 2));

  // Give 15 seconds for user to inspect the character in the game window
  console.log("\n=======================================================");
  console.log("Live Run PASSED! Keeping game window open for 15 seconds");
  console.log("so you can observe the character, facing, and equipped axe...");
  console.log("=======================================================\n");
  await new Promise((r) => setTimeout(r, 15000));

  if (smapiProcess && !smapiProcess.killed) {
    console.log("Cleaning up SMAPI process...");
    smapiProcess.kill();
  }

  if (result.outcome !== "pass") {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("Fatal error during live run:", err);
  process.exit(3);
});
