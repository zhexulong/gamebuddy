#!/usr/bin/env node
import { checkPortfolioPrerequisites } from "./lib/stardew-portfolio-profile.mjs";

const required = [
  "GAMEBUDDY_STARDEW_GAME_PATH",
  "GAMEBUDDY_PORTFOLIO_PROFILE_ROOT",
  "GAMEBUDDY_PORTFOLIO_DATA_ROOT",
  "GAMEBUDDY_PORTFOLIO_SAVE_NAME",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.log(
    JSON.stringify({
      state: "BLOCKED",
      topology: "single_player_native_companion",
      reasons: missing.map((name) => `portfolio_environment_missing:${name}`),
    }),
  );
  process.exitCode = 2;
} else {
  const result = await checkPortfolioPrerequisites({
    profileRoot: process.env.GAMEBUDDY_PORTFOLIO_PROFILE_ROOT,
    modsPath: process.env.GAMEBUDDY_PORTFOLIO_PROFILE_ROOT,
    dataRoot: process.env.GAMEBUDDY_PORTFOLIO_DATA_ROOT,
    saveName: process.env.GAMEBUDDY_PORTFOLIO_SAVE_NAME,
    gamePath: process.env.GAMEBUDDY_STARDEW_GAME_PATH,
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.state === "PASS" ? 0 : 2;
}
